//! Rule-based summaries for catalog/history results; live terminal reads stay intact.
use serde_json::{json, Map, Value};

const SUMMARY_BYTES: usize = 8_000;

fn protected(key: &str) -> bool {
    // Only narrative text is shortened; paths, graph references and unknown metadata stay exact.
    !matches!(
        key,
        "title"
            | "text"
            | "overview"
            | "content"
            | "body"
            | "message"
            | "label"
            | "reason"
            | "description"
            | "subject"
    )
}

fn excerpt(text: &str, chars: usize) -> String {
    if text.chars().count() <= chars {
        return text.into();
    }
    let head: String = text.chars().take(chars / 2).collect();
    let tail: String = text
        .chars()
        .rev()
        .take(chars / 4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let diagnostic = text
        .lines()
        .find(|line| {
            let lower = line.to_lowercase();
            [
                "error", "failed", "fatal", "panic", "denied", "错误", "失败",
            ]
            .iter()
            .any(|word| lower.contains(word))
        })
        .map(|line| line.chars().take(160).collect::<String>())
        .unwrap_or_default();
    format!("{head}\n[Condensed; read the archived output for omitted text.]\n{diagnostic}\n{tail}")
}

fn condensed(value: &Value, key: &str, strings: usize, arrays: usize) -> Value {
    match value {
        Value::String(text) if !protected(key) => json!(excerpt(text, strings)),
        Value::Array(items) if items.len() > arrays => json!({
            "items":items.iter().take(arrays).map(|item| condensed(item, key, strings, arrays)).collect::<Vec<_>>(),
            "totalItems":items.len(),"condensed":true,
        }),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| condensed(item, key, strings, arrays))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), condensed(value, key, strings, arrays)))
                .collect::<Map<_, _>>(),
        ),
        _ => value.clone(),
    }
}

pub(crate) fn for_model(tool: &str, raw: &str, output_id: i64) -> String {
    // Text needed for editing, permissions, terminal input and installer plans is never condensed.
    if raw.len() <= SUMMARY_BYTES
        || !matches!(
            tool,
            "history_list" | "conversation_search" | "project_inspect" | "project_graph_query"
        )
    {
        return raw.into();
    }
    let Ok(original) = serde_json::from_str::<Value>(raw) else {
        return raw.into();
    };
    if original["ok"] != true || original["uncertain"] == true {
        return raw.into();
    }
    for (strings, arrays) in [(256, 4), (128, 2), (64, 1)] {
        let mut result = condensed(&original, "", strings, arrays);
        let Some(object) = result.as_object_mut() else {
            return raw.into();
        };
        object.insert("condensed".into(), json!(true));
        object.insert("outputId".into(), json!(output_id));
        object.insert("originalBytes".into(), json!(raw.len()));
        object.insert("recovery".into(), json!("Use tool_output_read(outputId, offset) for original evidence. Omitted text is unknown. This archive is historical and cannot replace a fresh terminal read or grant permission. Never rerun an operation to recover output."));
        let text = result.to_string();
        if text.len() <= SUMMARY_BYTES {
            return text;
        }
    }
    // Keeping authoritative metadata is more important than achieving the size target.
    raw.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_summary_keeps_resume_metadata_and_can_be_recovered() {
        let sessions: Vec<_> = (0..100).map(|index| json!({"sessionId":index.to_string(),
            "cwd":"E:/project", "resumeToken":format!("exact:{index}"),"title":"长标题".repeat(200)})).collect();
        let raw = json!({"ok":true,"result":{"sessions":sessions}}).to_string();
        let summary = for_model("history_list", &raw, 42);
        assert!(summary.len() <= SUMMARY_BYTES && summary.len() < raw.len());
        let value: Value = serde_json::from_str(&summary).unwrap();
        assert_eq!(value["outputId"], 42);
        assert_eq!(value["result"]["sessions"]["totalItems"], 100);
        assert_eq!(
            value["result"]["sessions"]["items"][0]["resumeToken"],
            "exact:0"
        );
        assert_eq!(value["result"]["sessions"]["items"][0]["cwd"], "E:/project");
    }

    #[test]
    fn live_screens_actions_code_and_failed_results_stay_verbatim() {
        let raw = json!({"ok":true,"result":{"generation":"live:1","lines":["permission required".repeat(2000)]}}).to_string();
        for tool in [
            "terminal_read_screen",
            "terminal_send",
            "terminal_key",
            "file_read",
            "capability_prepare",
            "tool_output_read",
        ] {
            assert_eq!(for_model(tool, &raw, 1), raw);
        }
        let failure = json!({"ok":false,"error":"error details".repeat(2000)}).to_string();
        assert_eq!(for_model("project_inspect", &failure, 2), failure);
        let uncertain =
            json!({"ok":true,"uncertain":true,"result":"pending".repeat(2000)}).to_string();
        assert_eq!(for_model("project_inspect", &uncertain, 3), uncertain);
    }

    #[test]
    fn diagnostics_and_project_fingerprint_are_not_replaced_by_success_claims() {
        let raw = json!({"ok":true,"result":{"cwd":"E:/真实项目","fingerprint":"exact-project-revision",
            "overview":format!("{}\nerror: important failure\n{}", "progress\n".repeat(3000), "ending\n".repeat(1000))}}).to_string();
        let summary = for_model("project_inspect", &raw, 4);
        let value: Value = serde_json::from_str(&summary).unwrap();
        assert_eq!(value["result"]["fingerprint"], "exact-project-revision");
        assert_eq!(value["result"]["cwd"], "E:/真实项目");
        assert!(summary.contains("error: important failure"));
        assert!(value["condensed"].as_bool().unwrap());
    }

    #[test]
    fn long_paths_graph_references_and_unknown_metadata_stay_exact() {
        let path = format!("src/{}/main.rs", "目录".repeat(100));
        let node = "symbol::".repeat(100);
        let raw = json!({"ok":true,"result":{"matches":[{"id":node,"source_file":path,
            "source_location":"L100-L200","label":"说明".repeat(5000)}],
            "relations":[{"source":node,"target":node}],"futureReference":node}})
        .to_string();
        let summary = for_model("project_graph_query", &raw, 5);
        assert!(summary.len() <= SUMMARY_BYTES && summary.len() < raw.len());
        let value: Value = serde_json::from_str(&summary).unwrap();
        assert_eq!(value["result"]["matches"][0]["source_file"], path);
        assert_eq!(value["result"]["matches"][0]["id"], node);
        assert_eq!(value["result"]["relations"][0]["source"], node);
        assert_eq!(value["result"]["relations"][0]["target"], node);
        assert_eq!(value["result"]["futureReference"], node);
    }
}
