//! EnsoCode-compatible NaCl box key exchange and AES-256-GCM frames.
//! Wire format: version(1) || nonce(12) || ciphertext || tag(16).
use aes_gcm::{
    aead::{Aead, AeadCore, OsRng},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use crypto_box::{PublicKey, SalsaBox, SecretKey};
use serde_json::Value;

pub const MAX_FRAME: usize = 1_048_576;
pub const MAX_RPC_BYTES: usize = 8 * 1024 * 1024;
const RPC_CHUNK_BYTES: usize = 192 * 1024;
pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn decode(value: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "INVALID_ENCODING".into())
}
pub fn new_secret() -> SecretKey {
    SecretKey::generate(&mut OsRng)
}
pub fn random_token() -> String {
    encode(&new_secret().to_bytes())
}

pub fn unbox_key(boxed: &str, secret: &SecretKey) -> Result<Vec<u8>, String> {
    let parts: Vec<_> = boxed.split('.').collect();
    if parts.len() != 3 {
        return Err("INVALID_KEY_BOX".into());
    }
    let public: [u8; 32] = decode(parts[0])?
        .try_into()
        .map_err(|_| "INVALID_PUBLIC_KEY")?;
    let nonce = decode(parts[1])?;
    if nonce.len() != 24 {
        return Err("INVALID_NONCE".into());
    }
    let cipher = SalsaBox::new(&PublicKey::from(public), secret);
    let key = cipher
        .decrypt(
            crypto_box::Nonce::from_slice(&nonce),
            decode(parts[2])?.as_slice(),
        )
        .map_err(|_| "KEY_EXCHANGE_FAILED")?;
    if key.len() != 32 {
        return Err("INVALID_CONTENT_KEY".into());
    }
    Ok(key)
}

pub fn seal(key: &[u8], payload: &Value) -> Result<Vec<u8>, String> {
    let plain = serde_json::to_vec(payload).map_err(|_| "INVALID_PAYLOAD")?;
    if plain.len() + 29 > MAX_FRAME {
        return Err("RESPONSE_TOO_LARGE".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "INVALID_CONTENT_KEY")?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plain.as_slice())
        .map_err(|_| "ENCRYPT_FAILED")?;
    let mut frame = vec![1];
    frame.extend_from_slice(&nonce);
    frame.extend_from_slice(&ciphertext);
    Ok(frame)
}

pub fn open(key: &[u8], frame: &[u8]) -> Result<Value, String> {
    if !(29..=MAX_FRAME).contains(&frame.len()) || frame[0] != 1 {
        return Err("INVALID_FRAME".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "INVALID_CONTENT_KEY")?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&frame[1..13]), &frame[13..])
        .map_err(|_| "DECRYPT_FAILED")?;
    serde_json::from_slice(&plain).map_err(|_| "INVALID_JSON".into())
}

/// Each part is independently authenticated. The relay still sees only normal
/// bounded ciphertext frames, and older phone clients receive a clear 413.
pub fn seal_reply(key: &[u8], reply: &Value, allow_chunks: bool) -> Result<Vec<Vec<u8>>, String> {
    let bytes = serde_json::to_vec(reply).map_err(|_| "INVALID_PAYLOAD")?;
    if bytes.len() + 29 <= MAX_FRAME { return Ok(vec![seal(key, reply)?]); }
    if !allow_chunks || bytes.len() > MAX_RPC_BYTES {
        return Ok(vec![seal(key, &serde_json::json!({"type":"response", "id":reply["id"], "channel":reply["channel"], "status":413, "error":"RESPONSE_TOO_LARGE"}))?]);
    }
    let total = bytes.len().div_ceil(RPC_CHUNK_BYTES);
    bytes.chunks(RPC_CHUNK_BYTES).enumerate().map(|(index, part)| {
        seal(key, &serde_json::json!({"type":"response-chunk", "id":reply["id"], "channel":reply["channel"], "index":index, "total":total, "data":encode(part)}))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_unicode_responses_round_trip_in_bounded_authenticated_parts() {
        let key = [3; 32];
        let reply = serde_json::json!({"type":"response", "id":"test", "channel":"connection", "status":200, "data":"中文\n\"".repeat(200_000)});
        let frames = seal_reply(&key, &reply, true).unwrap();
        assert!(frames.len() > 1);
        let mut bytes = Vec::new();
        for (index, frame) in frames.iter().enumerate() {
            assert!(frame.len() <= MAX_FRAME);
            let part = open(&key, frame).unwrap();
            assert_eq!(part["index"], index);
            assert_eq!(part["total"], frames.len());
            bytes.extend(decode(part["data"].as_str().unwrap()).unwrap());
        }
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), reply);
        let legacy = seal_reply(&key, &reply, false).unwrap();
        assert_eq!(open(&key, &legacy[0]).unwrap()["status"], 413);
    }
    #[test]
    fn decrypts_browser_nacl_and_webcrypto_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../relay/test/crypto-vector.json")).unwrap();
        let secret_bytes: [u8; 32] = decode(fixture["secret"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let secret = SecretKey::from(secret_bytes);
        let key = unbox_key(fixture["boxed"].as_str().unwrap(), &secret).unwrap();
        assert_eq!(encode(&key), fixture["key"]);
        let frame = decode(fixture["frame"].as_str().unwrap()).unwrap();
        assert_eq!(open(&key, &frame).unwrap(), fixture["payload"]);
    }
    #[test]
    fn authenticated_frames_reject_tampering_wrong_key_and_version() {
        let key = [7; 32];
        let payload = serde_json::json!({"text": "你好", "id": "message-1"});
        let mut frame = seal(&key, &payload).unwrap();
        assert_eq!(open(&key, &frame).unwrap(), payload);
        assert!(open(&[8; 32], &frame).is_err());
        let last = frame.len() - 1;
        frame[last] ^= 1;
        assert!(open(&key, &frame).is_err());
        frame[0] = 2;
        assert!(open(&key, &frame).is_err());
        assert!(open(&key, &[1; 4]).is_err());
    }
}
