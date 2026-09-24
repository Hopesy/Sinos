//! Session-scoped mobile images. Only bounded PNGs produced by the phone's
//! image decoder are accepted; callers never choose a filesystem path.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::{Cursor, Read, Seek, SeekFrom, Write}, path::PathBuf};

pub const MAX_IMAGE: usize = 4 * 1024 * 1024;
pub const CHUNK: usize = 256 * 1024;
#[derive(Clone, Debug, Serialize)]
pub struct ImageMeta { pub id: String, pub name: String, pub reference: String, pub size: usize, pub width: u32, pub height: u32 }
#[derive(Default, Deserialize)]
pub struct ImageRequest {
    pub action: String,
    #[serde(default)] pub id: String,
    #[serde(default)] pub name: String,
    #[serde(default)] pub total: usize,
    #[serde(default)] pub offset: usize,
    #[serde(default)] pub data_base64: String,
}
struct Upload { name: String, total: usize, bytes: Vec<u8>, meta: Option<ImageMeta>, preview: Vec<u8>, retained: bool }
#[derive(Default)]
pub struct ImageStore { root: Option<PathBuf>, uploads: HashMap<String, Upload> }

impl ImageStore {
    pub fn list(&self) -> Vec<ImageMeta> { self.uploads.values().filter_map(|item| item.meta.clone()).collect() }
    pub fn metadata(&self, ids: &[String]) -> Result<Vec<ImageMeta>, &'static str> {
        if ids.len() > 4 { return Err("IMAGE_COUNT"); }
        let mut result = Vec::new();
        for id in ids {
            if result.iter().any(|item: &ImageMeta| &item.id == id) { return Err("IMAGE_CONFLICT"); }
            let meta = self.uploads.get(id).and_then(|item| item.meta.as_ref()).ok_or("IMAGE_NOT_FOUND")?;
            if !std::path::Path::new(&meta.reference).is_file() { return Err("IMAGE_NOT_FOUND"); }
            result.push(meta.clone());
        }
        Ok(result)
    }
    pub fn retain(&mut self, images: &[ImageMeta]) { for image in images { if let Some(item) = self.uploads.get_mut(&image.id) { item.retained = true; } } }
    pub fn prompt(text: &str, images: &[ImageMeta]) -> String {
        if images.is_empty() { return text.to_owned(); }
        let text = if text.trim().is_empty() { "请参考这些图片。" } else { text };
        format!("{text}\n\n参考图片：\n{}", images.iter().map(|item| format!("- {}", item.reference)).collect::<Vec<_>>().join("\n"))
    }
    fn root(&mut self) -> Result<PathBuf, &'static str> {
        if let Some(path) = &self.root { return Ok(path.clone()); }
        let temp = std::env::temp_dir().canonicalize().map_err(|_| "IMAGE_WRITE_FAILED")?;
        let parent = temp.join("sinos-mobile-images");
        std::fs::create_dir_all(&parent).map_err(|_| "IMAGE_WRITE_FAILED")?;
        let parent = parent.canonicalize().map_err(|_| "IMAGE_WRITE_FAILED")?;
        if !parent.starts_with(&temp) { return Err("IMAGE_WRITE_FAILED"); }
        prune_old_images(&parent);
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).map_err(|_| "IMAGE_WRITE_FAILED")?;
        self.root = Some(root.clone()); Ok(root)
    }
    pub fn handle(&mut self, request: ImageRequest) -> Result<serde_json::Value, &'static str> {
        use serde_json::json;
        if request.action == "list" { return Ok(json!({"images":self.list()})); }
        if uuid::Uuid::parse_str(&request.id).ok().is_none_or(|id| id.to_string() != request.id) { return Err("INVALID_IMAGE"); }
        if request.action == "upload" { return self.upload(request); }
        if request.action == "status" && self.uploads.get(&request.id).and_then(|item| item.meta.as_ref()).is_some_and(|meta| !std::path::Path::new(&meta.reference).is_file()) {
            self.uploads.remove(&request.id); return Err("IMAGE_NOT_FOUND");
        }
        let item = self.uploads.get(&request.id).ok_or("IMAGE_NOT_FOUND")?;
        match request.action.as_str() {
            "status" => Ok(json!({"received":if item.meta.is_some() {item.total} else {item.bytes.len()},"image":item.meta})),
            "preview" => { if item.meta.is_none() { return Err("IMAGE_NOT_FOUND"); } Ok(json!({"data_base64":STANDARD.encode(&item.preview)})) },
            "read" => {
                let meta = item.meta.as_ref().ok_or("IMAGE_NOT_FOUND")?;
                if request.offset >= meta.size { return Err("IMAGE_OFFSET"); }
                let bytes = read_part(meta, request.offset, CHUNK.min(meta.size - request.offset))?;
                Ok(json!({"data_base64":STANDARD.encode(&bytes),"next":request.offset + bytes.len(),"total":meta.size}))
            },
            "remove" => {
                if item.retained { return Err("IMAGE_IN_USE"); }
                if let Some(meta) = &item.meta { std::fs::remove_file(&meta.reference).map_err(|_| "IMAGE_WRITE_FAILED")?; }
                self.uploads.remove(&request.id); Ok(json!({"removed":true}))
            },
            _ => Err("INVALID_ACTION"),
        }
    }
    fn upload(&mut self, request: ImageRequest) -> Result<serde_json::Value, &'static str> {
        use serde_json::json;
        if request.total == 0 || request.total > MAX_IMAGE || request.data_base64.len() > (CHUNK + 2) / 3 * 4 { return Err("IMAGE_TOO_LARGE"); }
        let bytes = STANDARD.decode(&request.data_base64).map_err(|_| "INVALID_IMAGE")?;
        if bytes.is_empty() || bytes.len() > CHUNK || request.offset.checked_add(bytes.len()).is_none_or(|end| end > request.total) { return Err("IMAGE_OFFSET"); }
        if !self.uploads.contains_key(&request.id) {
            if request.offset != 0 { return Err("IMAGE_OFFSET"); }
            if self.uploads.len() >= 64 || self.uploads.values().map(|item| item.total).sum::<usize>() + request.total > 64 * 1024 * 1024 { return Err("IMAGE_STORAGE_FULL"); }
            let name: String = request.name.rsplit(['/', '\\']).next().unwrap_or("image.png").chars().filter(|ch| !ch.is_control()).take(120).collect();
            self.uploads.insert(request.id.clone(), Upload { name: if name.is_empty() {"image.png".into()} else {name}, total: request.total, bytes: Vec::new(), meta: None, preview: Vec::new(), retained: false });
        }
        let root = self.root()?;
        let item = self.uploads.get_mut(&request.id).unwrap();
        if item.total != request.total { return Err("IMAGE_CONFLICT"); }
        if let Some(meta) = &item.meta {
            if read_part(meta, request.offset, bytes.len())? != bytes { return Err("IMAGE_CONFLICT"); }
            return Ok(json!({"received":item.total,"image":meta}));
        }
        let end = request.offset + bytes.len();
        if request.offset < item.bytes.len() {
            if item.bytes.get(request.offset..end) != Some(bytes.as_slice()) { return Err("IMAGE_CONFLICT"); }
        } else if request.offset == item.bytes.len() { item.bytes.extend_from_slice(&bytes); }
        else { return Err("IMAGE_OFFSET"); }
        if item.bytes.len() == item.total {
            let decoded = validate_png(&item.bytes);
            let (width, height, preview) = match decoded { Ok(value) => value, Err(error) => { self.uploads.remove(&request.id); return Err(error); } };
            let path = root.join(format!("{}.png", request.id));
            // A failed write never leaves a file accepted as a ready image.
            let mut file = match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => file,
                Err(_) => { self.uploads.remove(&request.id); return Err("IMAGE_WRITE_FAILED"); }
            };
            let result = file.write_all(&item.bytes).and_then(|_| file.flush());
            drop(file);
            if result.is_err() { let _ = std::fs::remove_file(&path); self.uploads.remove(&request.id); return Err("IMAGE_WRITE_FAILED"); }
            let reference = path.to_string_lossy().into_owned();
            // Windows canonical paths use a verbatim prefix; present the
            // conventional absolute path understood by CLI image readers.
            #[cfg(windows)]
            let reference = if let Some(unc) = reference.strip_prefix("\\\\?\\UNC\\") { format!("\\\\{unc}") } else { reference.strip_prefix("\\\\?\\").unwrap_or(&reference).to_owned() };
            item.meta = Some(ImageMeta { id: request.id, name: item.name.clone(), reference, size: item.total, width, height });
            item.preview = preview; item.bytes = Vec::new();
        }
        Ok(json!({"received":if item.meta.is_some() {item.total} else {item.bytes.len()},"image":item.meta}))
    }
}
fn read_part(meta: &ImageMeta, offset: usize, length: usize) -> Result<Vec<u8>, &'static str> {
    let mut file = std::fs::File::open(&meta.reference).map_err(|_| "IMAGE_NOT_FOUND")?;
    file.seek(SeekFrom::Start(offset as u64)).map_err(|_| "IMAGE_NOT_FOUND")?;
    let mut bytes = vec![0; length]; file.read_exact(&mut bytes).map_err(|_| "IMAGE_NOT_FOUND")?; Ok(bytes)
}
fn validate_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), &'static str> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits { bytes: 40 * 1024 * 1024 });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| "INVALID_IMAGE")?;
    let (width, height) = (reader.info().width, reader.info().height);
    if width == 0 || height == 0 || width > 2048 || height > 2048 || reader.output_buffer_size() > 16 * 1024 * 1024 { return Err("IMAGE_TOO_LARGE"); }
    let mut pixels = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut pixels).map_err(|_| "INVALID_IMAGE")?;
    reader.finish().map_err(|_| "INVALID_IMAGE")?;
    let scale = (128.0_f32 / width.max(height) as f32).min(1.0);
    let w = ((width as f32 * scale) as u32).max(1); let h = ((height as f32 * scale) as u32).max(1);
    let mut thumb = Vec::with_capacity((w * h * 4) as usize);
    let channels = info.color_type.samples();
    for y in 0..h { for x in 0..w {
        let offset = (((y * height / h) * width + (x * width / w)) as usize) * channels;
        let sample = &pixels[offset..offset + channels];
        match channels {
            1 => thumb.extend_from_slice(&[sample[0], sample[0], sample[0], 255]),
            2 => thumb.extend_from_slice(&[sample[0], sample[0], sample[0], sample[1]]),
            3 => thumb.extend_from_slice(&[sample[0], sample[1], sample[2], 255]),
            4 => thumb.extend_from_slice(sample),
            _ => return Err("INVALID_IMAGE"),
        }
    } }
    let mut preview = Vec::new();
    let mut encoder = png::Encoder::new(&mut preview, w, h); encoder.set_color(png::ColorType::Rgba); encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().and_then(|mut writer| writer.write_image_data(&thumb)).map_err(|_| "INVALID_IMAGE")?;
    Ok((width, height, preview))
}
impl Drop for ImageStore {
    fn drop(&mut self) {
        // Sent images remain available for native history/resume. Unsent
        // drafts belong to this desktop session and can be discarded on exit.
        for item in self.uploads.values().filter(|item| !item.retained) { if let Some(meta) = &item.meta { let _ = std::fs::remove_file(&meta.reference); } }
        if let Some(root) = &self.root { let _ = std::fs::remove_dir(root); }
    }
}
fn prune_old_images(parent: &std::path::Path) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let Ok(dirs) = std::fs::read_dir(parent) else { return; };
        for dir in dirs.flatten() {
            if !dir.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()) || uuid::Uuid::parse_str(&dir.file_name().to_string_lossy()).is_err() { continue; }
            let Ok(files) = std::fs::read_dir(dir.path()) else { continue; };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().is_none_or(|e| e != "png") || path.file_stem().is_none_or(|s| uuid::Uuid::parse_str(&s.to_string_lossy()).is_err()) || !file.file_type().is_ok_and(|t| t.is_file() && !t.is_symlink()) { continue; }
                if file.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() > 7 * 86400) { let _ = std::fs::remove_file(path); }
            }
            let _ = std::fs::remove_dir(dir.path());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(crate) fn fixture_png(width: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, width, 2); encoder.set_color(png::ColorType::Rgba); encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().unwrap().write_image_data(&vec![127; (width * 2 * 4) as usize]).unwrap(); bytes
    }
    fn chunk(id: &str, bytes: &[u8], total: usize, offset: usize) -> ImageRequest { ImageRequest { action: "upload".into(), id: id.into(), name: "../photo.png".into(), total, offset, data_base64: STANDARD.encode(bytes) } }
    #[test]
    fn upload_resumes_and_repeated_chunks_are_idempotent() {
        let mut store = ImageStore::default(); let id = uuid::Uuid::new_v4().to_string(); let png = fixture_png(3); let middle = png.len()/2;
        assert_eq!(store.handle(chunk(&id, &png[..middle], png.len(), 0)).unwrap()["received"], middle);
        assert_eq!(store.handle(chunk(&id, &png[..middle], png.len(), 0)).unwrap()["received"], middle);
        assert_eq!(store.handle(chunk(&id, &[0], png.len(), 0)), Err("IMAGE_CONFLICT"));
        let ready = store.handle(chunk(&id, &png[middle..], png.len(), middle)).unwrap();
        assert_eq!(ready["image"]["width"], 3); assert_eq!(ready["image"]["name"], "photo.png");
        assert_eq!(store.handle(chunk(&id, &png[middle..], png.len(), middle)).unwrap(), ready);
        let meta = store.metadata(&[id.clone()]).unwrap().remove(0);
        assert_eq!(std::fs::read(&meta.reference).unwrap(), png);
        assert!(meta.reference.ends_with(&format!("{id}.png")));
        let preview = store.handle(ImageRequest { action: "preview".into(), id: id.clone(), ..Default::default() }).unwrap();
        assert!(STANDARD.decode(preview["data_base64"].as_str().unwrap()).unwrap().starts_with(b"\x89PNG"));
        assert!(ImageStore::default().metadata(&[id.clone()]).is_err());
        store.handle(ImageRequest { action: "remove".into(), id, ..Default::default() }).unwrap();
        assert!(!std::path::Path::new(&meta.reference).exists());
    }
    #[test]
    fn invalid_paths_formats_dimensions_and_chunk_offsets_are_rejected() {
        let mut store = ImageStore::default(); let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(store.handle(chunk("../../file", b"x", 1, 0)), Err("INVALID_IMAGE"));
        assert_eq!(store.handle(chunk(&id, b"x", MAX_IMAGE + 1, 0)), Err("IMAGE_TOO_LARGE"));
        assert_eq!(store.handle(chunk(&id, b"x", 2, 1)), Err("IMAGE_OFFSET"));
        assert_eq!(store.handle(chunk(&id, b"<svg/>", 6, 0)), Err("INVALID_IMAGE"));
        assert!(store.list().is_empty());
        let png = fixture_png(2049); assert_eq!(store.handle(chunk(&id, &png, png.len(), 0)), Err("IMAGE_TOO_LARGE"));
        let mut png = fixture_png(3); png[40] ^= 1;
        assert_eq!(store.handle(chunk(&id, &png, png.len(), 0)), Err("INVALID_IMAGE"));
    }
    #[test]
    fn sent_images_survive_draft_cleanup_and_missing_files_can_be_uploaded_again() {
        let mut store = ImageStore::default(); let id = uuid::Uuid::new_v4().to_string(); let png = fixture_png(3);
        store.handle(chunk(&id, &png, png.len(), 0)).unwrap();
        let images = store.metadata(&[id.clone()]).unwrap(); store.retain(&images);
        assert_eq!(store.handle(ImageRequest { action: "remove".into(), id: id.clone(), ..Default::default() }), Err("IMAGE_IN_USE"));
        assert!(ImageStore::prompt("", &images).starts_with("请参考这些图片。\n\n参考图片：\n- "));
        std::fs::remove_file(&images[0].reference).unwrap();
        assert_eq!(store.handle(ImageRequest { action: "status".into(), id: id.clone(), ..Default::default() }), Err("IMAGE_NOT_FOUND"));
        store.handle(chunk(&id, &png, png.len(), 0)).unwrap();
    }
    #[test]
    fn image_only_queue_preserves_attachments_when_edited_and_claimed() {
        let mut runtime = crate::remote_runtime::Runtime::new(); let id = uuid::Uuid::new_v4().to_string(); let png = fixture_png(3);
        runtime.images.handle(chunk(&id, &png, png.len(), 0)).unwrap();
        let mut request = crate::remote_runtime::QueueRequest { action: "enqueue".into(), id: "message".into(), text: String::new(), attachments: vec![id.clone()], expected_revision: None };
        runtime.enqueue(&request).unwrap(); assert_eq!(runtime.queue[0].attachments[0].id, id);
        request.action = "edit".into(); request.text = "按照截图调整".into(); request.expected_revision = Some(1);
        runtime.mutate(&request).unwrap();
        let item = runtime.claim(Some("message"), Some(2)).unwrap(); assert_eq!(item.attachments[0].id, id);
        assert!(ImageStore::prompt(&item.text, &item.attachments).contains("按照截图调整"));
    }
}
