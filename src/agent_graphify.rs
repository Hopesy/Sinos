//! Actual Graphify CLI plans run in a visible Coffee terminal; graph reads stay local.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashSet}, fs, io::Read, path::{Component, Path, PathBuf}, process::Command, sync::Mutex};

const ENGINE_VERSION: &str = "0.9.85";
const MAX_GRAPH_BYTES: usize = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES: usize = 128 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_CONTEXT: usize = 12_000;
const EXCLUDES: &[&str] = &[".git", "node_modules", "target", "dist", "build", "vendor", ".venv", "venv", "__pycache__", "graphify-out", ".env*", "*.pem", "*.key"];
const SECRET_WORDS: &[&str] = &["secret", "credential", "password", "token"];
const SECRET_CONFIG_EXTENSIONS: &[&str] = &["json", "yaml", "yml", "toml", "ini", "cfg", "conf", "config", "xml", "properties", "tfvars"];
// Official 0.9.85 detect.CODE_EXTENSIONS, plus common project configuration files.
const EXTENSIONS: &[&str] = &["py", "pyi", "js", "mjs", "cjs", "jsx", "ejs", "ets", "ts", "tsx", "mts", "cts", "rs", "go", "vb", "cbl", "cob", "cobol", "cpy", "java", "kt", "kts", "scala", "groovy", "gradle", "c", "h", "cc", "cpp", "hpp", "cxx", "hh", "hxx", "cu", "cuh", "metal", "cs", "swift", "rb", "rake", "php", "lua", "luau", "toc", "zig", "sh", "bash", "zsh", "ps1", "psm1", "psd1", "sql", "r", "dart", "ex", "exs", "erl", "hrl", "escript", "hs", "ml", "mli", "m", "mm", "jl", "fs", "fsx", "vue", "svelte", "astro", "v", "sv", "svh", "vh", "f", "f90", "f95", "f03", "f08", "pas", "pp", "dpr", "dpk", "lpr", "inc", "dfm", "lfm", "lpk", "json", "toml", "yaml", "yml", "tf", "tfvars", "hcl", "dm", "dme", "dmi", "dmm", "dmf", "sln", "slnx", "csproj", "fsproj", "vbproj", "xaml", "razor", "cshtml", "cls", "trigger", "lisp", "cl", "lsp", "asd", "robot", "resource", "sol"];
static GRAPH_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan { id: String, identity: String, cwd: String, kind: String, executable: String, fingerprint: String, approved: bool }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache { identity: String, cwd: String, plan_id: String, fingerprint: String, graph_hash: String }

fn hash(bytes: &[u8]) -> String { let mut value = 0xcbf29ce484222325u64; for byte in bytes { value = (value ^ *byte as u64).wrapping_mul(0x100000001b3); } format!("{value:016x}") }
fn cwd_id(cwd: &Path) -> String { let text = dunce::simplified(cwd).to_string_lossy().into_owned(); if cfg!(windows) { text.to_ascii_lowercase() } else { text } }
fn read(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    if !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink()) { return Err("Graphify file unavailable or symlink".into()); }
    let mut bytes = Vec::new(); fs::File::open(path).map_err(|_| "Graphify file unavailable")?.take(max as u64 + 1).read_to_end(&mut bytes).map_err(|_| "Graphify file unreadable")?;
    if bytes.len() > max { return Err("Graphify file exceeds its read budget".into()); } Ok(bytes)
}
fn write(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) { return Err("Graphify storage cannot use symlinks".into()); }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, serde_json::to_vec_pretty(value).map_err(|_| "Graphify data invalid")?).map_err(|_| "Graphify storage unavailable")?;
    let result = crate::agent::replace_file(&temporary, path); if result.is_err() { let _ = fs::remove_file(temporary); } result
}
fn directory(root: &Path, segments: &[&str]) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|_| "Agent storage unavailable")?;
    let canonical_root = root.canonicalize().map_err(|_| "Agent storage unavailable")?;
    let mut path = root.to_path_buf();
    for segment in segments {
        path.push(segment); if !path.exists() { fs::create_dir(&path).map_err(|_| "Graphify storage unavailable")?; }
        if fs::symlink_metadata(&path).map_err(|_| "Graphify storage unavailable")?.file_type().is_symlink() || !path.canonicalize().map_err(|_| "Graphify storage unavailable")?.starts_with(&canonical_root) { return Err("Graphify storage resolves outside Agent storage".into()); }
    } Ok(path)
}
fn scope(root: &Path, identity: &str, cwd: &Path) -> Result<PathBuf, String> {
    if identity.is_empty() || identity.len() > 1_000 { return Err("Invalid Graphify identity".into()); }
    // Resolve parent aliases before creating a cache whose final directories do not exist yet.
    let mut ancestor = root;
    let mut suffix = Vec::new();
    let resolved_root = loop {
        match ancestor.canonicalize() {
            Ok(mut path) => {
                for segment in suffix.iter().rev() { path.push(segment); }
                break path;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(ancestor.file_name().ok_or("Invalid Graphify storage path")?.to_os_string());
                ancestor = ancestor.parent().ok_or("Invalid Graphify storage path")?;
            }
            Err(_) => return Err("Graphify storage path unavailable".into()),
        }
    };
    if dunce::simplified(&resolved_root).starts_with(dunce::simplified(cwd)) { return Err("Graphify cache must stay outside the selected project; select its actual source directory".into()); }
    directory(root, &["graphify", &hash(identity.as_bytes()), &hash(cwd_id(cwd).as_bytes())])
}
fn valid_id(id: &str) -> Result<(), String> { if uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id) { Ok(()) } else { Err("Invalid Graphify plan ID".into()) } }
fn plan_path(root: &Path, id: &str) -> Result<PathBuf, String> { valid_id(id)?; Ok(directory(root, &["graphify", "plans"])?.join(format!("{id}.json"))) }
fn load_plan(root: &Path, id: &str) -> Result<Plan, String> {
    let plan: Plan = serde_json::from_slice(&read(&plan_path(root, id)?, 16_384)?).map_err(|_| "Graphify plan invalid")?;
    if plan.id != id || !matches!(plan.kind.as_str(), "build" | "install") { return Err("Graphify plan invalid".into()); } Ok(plan)
}
fn executable(name: &str) -> Option<PathBuf> {
    let name = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let mut paths: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).filter(|path| path.is_absolute()).collect();
    if let Some(home) = dirs::home_dir() { paths.push(home.join(".local/bin")); }
    paths.into_iter().map(|path| path.join(&name)).find(|path| path.is_file()).and_then(|path| dunce::canonicalize(path).ok())
}
fn blocked(name: &str) -> bool {
    let name = name.to_ascii_lowercase(); EXCLUDES[..10].contains(&name.as_str()) || name.starts_with(".env") || name.ends_with(".pem") || name.ends_with(".key")
        || (SECRET_CONFIG_EXTENSIONS.contains(&Path::new(&name).extension().unwrap_or_default().to_string_lossy().as_ref()) && SECRET_WORDS.iter().any(|word|name.contains(word)))
}
fn source_fingerprint(cwd: &Path) -> Result<String, String> {
    let git = crate::git::project_snapshot(&dunce::simplified(cwd).to_string_lossy());
    let graphify_rules = read(&cwd.join(".graphifyignore"),8_192).ok().and_then(|bytes|String::from_utf8(bytes).ok()).unwrap_or_default();
    let fallback_rules = if git["state"] != "ok" { read(&cwd.join(".gitignore"),8_192).ok().and_then(|bytes|String::from_utf8(bytes).ok()).unwrap_or_default() } else { String::new() };
    let mut files = Vec::new(); let mut queue = vec![cwd.to_path_buf()]; let mut entries = 0;
    while !queue.is_empty() {
        let mut directories = Vec::new();
        for directory in std::mem::take(&mut queue) {
            let relative=directory.strip_prefix(cwd).map_err(|_|"Graphify source outside project")?.to_string_lossy().replace('\\',"/");
            if !relative.is_empty() && (crate::agent_projects::ignored_by_rules(&relative,&graphify_rules) || crate::agent_projects::ignored_by_rules(&relative,&fallback_rules)) { continue; }
            directories.push((directory, relative));
        }
        // Query one tree level at a time, before reading ignored subtrees.
        let refs: Vec<_> = directories.iter().map(|(_, relative)| relative.as_str()).filter(|relative| !relative.is_empty()).collect();
        let ignored = if git["state"] == "ok" && !refs.is_empty() { crate::git::project_ignored(&dunce::simplified(cwd).to_string_lossy(), &refs)? } else { HashSet::new() };
        for (directory, relative) in directories {
            if ignored.contains(&relative) { continue; }
            for entry in fs::read_dir(directory).map_err(|_| "Graphify source directory unreadable")? {
                entries += 1; if entries > MAX_ENTRIES { return Err("Graphify source freshness exceeds 20000-entry budget; select a smaller project directory".into()); }
                let entry = entry.map_err(|_| "Graphify source unavailable")?; let name = entry.file_name().to_string_lossy().into_owned();
                let kind = entry.file_type().map_err(|_| "Graphify source unavailable")?;
                if blocked(&name) || kind.is_symlink() { continue; }
                if kind.is_dir() { queue.push(entry.path()); }
                else if kind.is_file() && (entry.path().extension().is_none() || EXTENSIONS.contains(&entry.path().extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase().as_str()) || matches!(name.as_str(), ".gitignore" | ".graphifyignore")) {
                    files.push(entry.path().strip_prefix(cwd).map_err(|_| "Graphify source outside project")?.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    files.sort();
    let refs: Vec<_> = files.iter().map(String::as_str).collect();
    let ignored = if git["state"] == "ok" && !refs.is_empty() { crate::git::project_ignored(&dunce::simplified(cwd).to_string_lossy(), &refs)? } else { HashSet::new() };
    let mut fingerprint = format!("{}:{}:{}:{}", cwd_id(cwd), git["state"], git["head"], git["branch"]); let mut total = 0;
    for file in files {
        if ignored.contains(&file) || (!matches!(file.as_str(),".gitignore"|".graphifyignore") && (crate::agent_projects::ignored_by_rules(&file,&graphify_rules) || crate::agent_projects::ignored_by_rules(&file,&fallback_rules))) { continue; }
        let bytes = read(&cwd.join(&file), MAX_SOURCE_BYTES - total)?; total += bytes.len();
        fingerprint.push_str(&format!("|{file}:{}", hash(&bytes)));
    }
    Ok(hash(fingerprint.as_bytes()))
}
fn output(root: &Path, plan: &Plan, cwd: &Path) -> Result<PathBuf, String> { let base = scope(root, &plan.identity, cwd)?; directory(&base, &["runs", &plan.id]) }
fn argv(plan: &Plan, out: &Path) -> Vec<String> {
    if plan.kind == "install" { return vec!["tool".into(), "install".into(), format!("graphifyy=={ENGINE_VERSION}")]; }
    let mut args = vec!["extract".into(), plan.cwd.clone(), "--code-only".into(), "--no-cluster".into(), "--max-workers".into(), "2".into(), "--out".into(), dunce::simplified(out).to_string_lossy().into_owned()];
    for pattern in EXCLUDES { args.push("--exclude".into()); args.push(pattern.to_string()); }
    for word in SECRET_WORDS { for extension in SECRET_CONFIG_EXTENSIONS { args.push("--exclude".into()); args.push(format!("*{word}*.{extension}")); } }
    args
}
fn result_path(root: &Path, id: &str) -> Result<PathBuf, String> { valid_id(id)?; Ok(directory(root, &["graphify", "plans"])?.join(format!("{id}.result.json"))) }

/// Creates only private Agent cache data; the caller runs the returned plan in a visible terminal.
pub(crate) fn prepare_build(root: &Path, identity: &str, cwd: &str, refresh: bool) -> Result<Value, String> {
    let canonical = crate::agent::canonical_directory(cwd)?; let _ = scope(root,identity,&canonical)?;
    let existing = inspect(root, identity, cwd).unwrap_or_else(|error|json!({"state":"unavailable","error":error}));
    if !refresh && existing["state"] == "ready" { return Ok(existing); }
    let Some(engine) = executable("graphify") else { return Ok(json!({"state":"dependency_required","package":"graphifyy","version":ENGINE_VERSION,"requiresConfirmation":true,"graph":existing})); };
    let plan = Plan { id:uuid::Uuid::new_v4().to_string(), identity:identity.into(), cwd:dunce::simplified(&canonical).to_string_lossy().into_owned(), kind:"build".into(), executable:engine.to_string_lossy().into_owned(), fingerprint:source_fingerprint(&canonical)?, approved:true };
    let out = output(root, &plan, &canonical)?; write(&plan_path(root, &plan.id)?, &plan)?;
    Ok(json!({"state":"needs_build","planId":plan.id,"kind":"build","cwd":plan.cwd,"executable":plan.executable,"argv":argv(&plan,&out),"outputPath":out.join("graphify-out/graph.json"),"visibleTerminalRequired":true,"codeOnly":true}))
}
pub(crate) fn prepare_install(root: &Path, identity: &str, cwd: &str) -> Result<Value, String> {
    let canonical = crate::agent::canonical_directory(cwd)?; let _ = scope(root, identity, &canonical)?;
    let Some(engine) = executable("uv") else { return Ok(json!({"state":"needs_runtime","runtime":"uv","package":"graphifyy","requiresConfirmation":true})); };
    let plan = Plan { id:uuid::Uuid::new_v4().to_string(), identity:identity.into(), cwd:dunce::simplified(&canonical).to_string_lossy().into_owned(), kind:"install".into(), executable:engine.to_string_lossy().into_owned(), fingerprint:String::new(), approved:false };
    write(&plan_path(root, &plan.id)?, &plan)?;
    Ok(json!({"state":"confirmation_required","planId":plan.id,"cwd":plan.cwd,"kind":"install","name":"graphify","source":"https://pypi.org/project/graphifyy/","scope":"user-tool","executable":plan.executable,"argv":argv(&plan,Path::new("")),"requiresConfirmation":true,"visibleTerminalRequired":true,"package":"graphifyy","version":ENGINE_VERSION}))
}
pub(crate) fn approve_install(root: &Path, identity: &str, id: &str) -> Result<(), String> {
    let _lock = GRAPH_LOCK.lock().map_err(|_| "Graphify storage lock failed")?; let mut plan = load_plan(root,id)?;
    if plan.identity != identity || plan.kind != "install" { return Err("Graphify installation identity mismatch".into()); }
    plan.approved = true; write(&plan_path(root,id)?, &plan)
}

/// Called only from the Coffee CLI helper launched in a real terminal, never the Agent worker.
pub(crate) fn apply_build(root: &Path, id: &str) -> Result<Value, String> {
    let plan = load_plan(root,id)?; if !plan.approved { return Err("Graphify installation requires user confirmation".into()); }
    let cwd = crate::agent::canonical_directory(&plan.cwd)?; let out = output(root,&plan,&cwd)?;
    let receipt = result_path(root,id)?;
    // A durable claim prevents two terminal helpers from executing the same plan.
    let claim = plan_path(root,id)?.with_extension("started");
    fs::OpenOptions::new().write(true).create_new(true).open(&claim).map_err(|_| "Graphify plan has already started")?;
    let execute = || -> Result<Value, String> {
        let expected = executable(if plan.kind == "install" {"uv"} else {"graphify"}).ok_or("Graphify executable unavailable")?;
        if expected != PathBuf::from(&plan.executable) { return Err("Graphify executable changed after planning; prepare again".into()); }
        if plan.kind == "build" && source_fingerprint(&cwd)? != plan.fingerprint { return Err("Project changed after Graphify planning; prepare again".into()); }
        println!("Coffee CLI: {} {}",plan.executable,argv(&plan,&out).join(" "));
        let status = Command::new(&plan.executable).args(argv(&plan,&out)).env("GRAPHIFY_NO_AUTO_REFRESH","1").current_dir(dunce::simplified(&cwd)).status().map_err(|error| format!("Graphify process failed: {error}"))?;
        if !status.success() { return Err(format!("Graphify {} failed with exit {:?}; inspect the visible terminal output",plan.kind,status.code())); }
        if plan.kind == "install" {
            let installed=executable("graphify").ok_or("Installation exited successfully but graphify executable is unavailable")?;
            println!("Coffee CLI: verifying {} --version",installed.display());
            let version=Command::new(&installed).arg("--version").env("GRAPHIFY_NO_AUTO_REFRESH","1").current_dir(dunce::simplified(&cwd)).output().map_err(|error|format!("Graphify version verification failed: {error}"))?;
            let text=String::from_utf8_lossy(&version.stdout); print!("{text}"); eprint!("{}",String::from_utf8_lossy(&version.stderr));
            if !version.status.success() || !text.split_whitespace().any(|part|part==ENGINE_VERSION) { return Err(format!("Installed Graphify version was not verified as {ENGINE_VERSION}; check the visible terminal and PATH")); }
            return Ok(json!({"state":"installed","planId":id,"package":"graphifyy","version":ENGINE_VERSION,"available":true,"verified":true,"executable":installed}));
        }
        let graph_dir = out.join("graphify-out"); let graph_path = graph_dir.join("graph.json");
        let (graph,bytes) = load_graph(&graph_path,&cwd)?;
        for node in &graph.nodes { if let Some(source)=node["source_file"].as_str().filter(|text|!text.is_empty()) { if !source_path(&cwd,source)?.is_file() { return Err("Graphify output references a missing source file; graph was not published".into()); } } }
        let marker = String::from_utf8(read(&graph_dir.join(".graphify_root"),16_384)?).map_err(|_| "Graphify root marker invalid")?;
        if crate::agent::canonical_directory(marker.trim())? != cwd { return Err("Graphify output belongs to a different workspace".into()); }
        if source_fingerprint(&cwd)? != plan.fingerprint { return Err("Project changed while Graphify was scanning; graph was not published".into()); }
        let cache = Cache { identity:plan.identity.clone(), cwd:cwd_id(&cwd), plan_id:id.into(), fingerprint:plan.fingerprint.clone(), graph_hash:hash(&bytes) };
        write(&scope(root,&plan.identity,&cwd)?.join("current.json"),&cache)?;
        Ok(json!({"state":"ready","planId":id,"graph":summary(&graph),"fingerprint":hash(&bytes)}))
    };
    let result = execute(); let mut value = match &result { Ok(value)=>value.clone(), Err(error)=>json!({"state":"failed","planId":id,"error":error}) };
    value["cwd"]=json!(plan.cwd); value["kind"]=json!(plan.kind); write(&receipt,&value)?;
    match result { Ok(_)=>Ok(value),Err(error)=>Err(error) }
}

pub(crate) fn plan_result(root: &Path, identity: &str, id: &str) -> Result<Value, String> {
    let plan = load_plan(root,id)?; if plan.identity != identity { return Err("Graphify plan identity mismatch".into()); }
    let path = result_path(root,id)?; if !path.exists() { return Ok(json!({"state":if plan_path(root,id)?.with_extension("started").exists(){"running"}else{"pending"},"planId":id,"cwd":plan.cwd,"kind":plan.kind})); }
    serde_json::from_slice(&read(&path,MAX_CONTEXT)?).map_err(|_| "Graphify receipt invalid".into())
}

#[derive(Debug)]
struct Graph { nodes: Vec<Value>, edges: Vec<Value>, schema: Value, version: Value }
fn source_path(cwd: &Path, text: &str) -> Result<PathBuf, String> {
    if text.len() > 1_024 { return Err("Graphify source path exceeds its budget".into()); }
    let text = text.replace('\\', "/"); let relative = Path::new(&text);
    if text.contains(':') || relative.components().any(|component| !matches!(component,Component::Normal(_))) || relative.components().any(|part|blocked(&part.as_os_str().to_string_lossy())) { return Err("Graphify source path outside allowed project scope".into()); }
    let mut path = cwd.to_path_buf(); for part in relative.components() { path.push(part); if fs::symlink_metadata(&path).is_ok_and(|meta|meta.file_type().is_symlink()) { return Err("Graphify source cannot use symlinks".into()); } }
    if path.exists() && !path.canonicalize().map_err(|_|"Graphify source unavailable")?.starts_with(cwd) { return Err("Graphify source resolves outside project".into()); } Ok(path)
}
fn clipped(value: &Value, name: &str, max: usize) -> Value { value[name].as_str().map(|text|json!(text.chars().take(max).collect::<String>())).unwrap_or(Value::Null) }
fn load_graph(path: &Path, cwd: &Path) -> Result<(Graph,Vec<u8>), String> {
    let bytes = read(path,MAX_GRAPH_BYTES)?; let data: Value=serde_json::from_slice(&bytes).map_err(|_|"Graphify graph.json invalid")?;
    let schema=data["graph"]["schema_version"].clone(); if !schema.is_null() && schema != 1 { return Err("Unsupported Graphify graph schema".into()); }
    let raw_nodes=data["nodes"].as_array().ok_or("Graphify nodes array missing")?;
    let raw_edges=data.get("links").or_else(||data.get("edges")).and_then(Value::as_array).ok_or("Graphify relations array missing")?;
    if raw_nodes.len()>100_000 || raw_edges.len()>200_000 { return Err("Graphify graph exceeds the node or relation budget".into()); }
    let mut ids=HashSet::new(); let mut nodes=Vec::new();
    for node in raw_nodes {
        let id=node["id"].as_str().filter(|id|!id.is_empty() && id.len()<=1_024).ok_or("Graphify node ID invalid")?;
        if !ids.insert(id.to_string()) { return Err("Graphify graph has duplicate node IDs".into()); }
        let source=node["source_file"].as_str().unwrap_or_default(); if !source.is_empty() { let _=source_path(cwd,source)?; }
        nodes.push(json!({"id":id,"label":clipped(node,"label",200),"source_file":source,"source_location":clipped(node,"source_location",100),"type":clipped(node,"type",100),"file_type":clipped(node,"file_type",50),"external":node["external"]==true}));
    }
    let mut edges=Vec::new();
    for edge in raw_edges {
        let source=edge["source"].as_str().ok_or("Graphify relation source missing")?; let target=edge["target"].as_str().ok_or("Graphify relation target missing")?;
        if !ids.contains(source) || !ids.contains(target) { return Err("Graphify relation has an unknown endpoint".into()); }
        if let Some(file)=edge["source_file"].as_str().filter(|file|!file.is_empty()) { let _=source_path(cwd,file)?; }
        edges.push(json!({"source":source,"target":target,"relation":clipped(edge,"relation",100),"confidence":clipped(edge,"confidence",30),"source_file":clipped(edge,"source_file",1_024),"source_location":clipped(edge,"source_location",100)}));
    }
    Ok((Graph{nodes,edges,schema,version:clipped(&data["graph"],"graphify_version",100)},bytes))
}
fn summary(graph: &Graph) -> Value {
    let mut files=BTreeMap::new(); let mut relations=BTreeMap::new();
    for node in &graph.nodes { if let Some(source)=node["source_file"].as_str().filter(|text|!text.is_empty()){ *files.entry(source).or_insert(0usize)+=1; } }
    for edge in &graph.edges { *relations.entry(edge["relation"].as_str().unwrap_or("unknown")).or_insert(0usize)+=1; }
    json!({"nodes":graph.nodes.len(),"relations":graph.edges.len(),"sourceFiles":files.len(),"schemaVersion":graph.schema,"graphifyVersion":graph.version,"sampleFiles":files.into_iter().take(6).map(|(file,nodes)|json!({"path":file.chars().take(160).collect::<String>(),"nodes":nodes,"truncated":file.chars().count()>160})).collect::<Vec<_>>(),"relationTypes":relations.into_iter().take(8).map(|(relation,count)|json!({"relation":relation.chars().take(60).collect::<String>(),"count":count})).collect::<Vec<_>>(),"coverage":"Local code AST only; documents and media were not semantically analyzed; dependency/build directories and sensitive configuration files excluded"})
}
fn cached(root: &Path, identity: &str, cwd: &Path) -> Result<Option<(Cache,Graph,Vec<u8>)>, String> {
    let base=scope(root,identity,cwd)?; let path=base.join("current.json");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        _ => return Err("Graphify cache metadata unavailable or symlink".into()),
    }
    let cache:Cache=serde_json::from_slice(&read(&path,16_384)?).map_err(|_|"Graphify cache metadata invalid")?;
    if cache.identity!=identity || cache.cwd!=cwd_id(cwd){return Err("Graphify cache identity or project mismatch".into());} valid_id(&cache.plan_id)?;
    let graph_dir=directory(&base,&["runs",&cache.plan_id,"graphify-out"])?;
    let (graph,bytes)=load_graph(&graph_dir.join("graph.json"),cwd)?;
    if cache.graph_hash!=hash(&bytes){return Err("Graphify cached graph changed outside its verified build".into());}
    Ok(Some((cache,graph,bytes)))
}
pub(crate) fn inspect(root: &Path, identity: &str, cwd: &str) -> Result<Value, String> {
    let cwd=crate::agent::canonical_directory(cwd)?;
    let Some((cache,graph,bytes))=cached(root,identity,&cwd)? else {return Ok(json!({"state":"missing","engineInstalled":executable("graphify").is_some(),"codeOnly":true}));};
    let current_fingerprint=source_fingerprint(&cwd)?;
    let fresh=cache.fingerprint==current_fingerprint;
    Ok(json!({"state":if fresh{"ready"}else{"stale"},"fingerprint":hash(&bytes),"sourceFingerprint":cache.fingerprint,"currentSourceFingerprint":current_fingerprint,"planId":cache.plan_id,"graph":summary(&graph),"codeOnly":true,"evidence":"Extracted Graphify structural relationships; not task completion or user permission"}))
}
pub(crate) fn query(root: &Path, identity: &str, cwd: &str, query: &str, limit: usize) -> Result<Value, String> {
    if query.trim().is_empty() || query.chars().count()>500 {return Err("Graphify query must contain 1–500 characters".into());}
    let cwd=crate::agent::canonical_directory(cwd)?;
    let Some((cache,graph,_))=cached(root,identity,&cwd)? else {return Ok(json!({"state":"missing","matches":[],"relations":[]}));};
    if cache.fingerprint!=source_fingerprint(&cwd)? {return Ok(json!({"state":"stale","matches":[],"relations":[],"requiresBuild":true}));}
    let terms:Vec<_>=query.to_lowercase().split(|ch:char|!ch.is_alphanumeric() && ch!='_').filter(|part|part.chars().count()>1).take(20).map(str::to_string).collect();
    let limit=limit.clamp(1,12); let mut ranked=Vec::new();
    for (index,node) in graph.nodes.iter().enumerate(){let text=format!("{} {} {}",node["id"],node["label"],node["source_file"]).to_lowercase();let score=terms.iter().filter(|term|text.contains(term.as_str())).count();if score>0{ranked.push((score,index));}}
    ranked.sort_by(|a,b|b.0.cmp(&a.0).then(a.1.cmp(&b.1)));ranked.truncate(limit);
    let matches:Vec<_>=ranked.iter().map(|(_,index)|graph.nodes[*index].clone()).collect();
    let mut selected:HashSet<String>=matches.iter().map(|node|node["id"].as_str().unwrap().to_string()).collect();
    let mut selected_edges=Vec::new();let mut seen=HashSet::new();
    for _ in 0..2 { let frontier=selected.clone();for (index,edge) in graph.edges.iter().enumerate(){let source=edge["source"].as_str().unwrap();let target=edge["target"].as_str().unwrap();if (frontier.contains(source)||frontier.contains(target)) && seen.insert(index){if selected.len()>=40 || selected_edges.len()>=60{break;}selected.insert(source.into());selected.insert(target.into());selected_edges.push(edge.clone());}} }
    let neighbors:Vec<_>=graph.nodes.iter().filter(|node|selected.contains(node["id"].as_str().unwrap())).take(40).cloned().collect();
    let mut result=json!({"state":"ready","query":query,"method":"Bounded text matching and two-hop lookup of actual Graphify relationships","matches":matches,"neighbors":neighbors,"relations":selected_edges,"truncated":selected.len()>=40 || seen.len()>=60,"evidence":"Graphify code structure, not a semantic answer or permission; verify references against current code"});
    while result.to_string().len()>MAX_CONTEXT { if let Some(relations)=result["relations"].as_array_mut().filter(|items|!items.is_empty()){relations.pop();}else if let Some(neighbors)=result["neighbors"].as_array_mut().filter(|items|!items.is_empty()){neighbors.pop();}else if let Some(matches)=result["matches"].as_array_mut().filter(|items|!items.is_empty()){matches.pop();}else{return Err("Graphify query context exceeds budget".into());}result["truncated"]=json!(true); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf,PathBuf,PathBuf) {let root=std::env::temp_dir().join(format!("coffee-graphify-{}",uuid::Uuid::new_v4()));let cwd=root.join("workspace");fs::create_dir_all(cwd.join("src")).unwrap();fs::write(cwd.join("src/main.py"),"from helper import greet\ngreet()\n").unwrap();fs::write(cwd.join("src/helper.py"),"def greet():\n    return 'hello'\n").unwrap();(root.clone(),root.join("agent"),cwd)}
    fn seed(root:&Path,identity:&str,cwd:&Path,clustered:bool)->String {let id=uuid::Uuid::new_v4().to_string();let plan=Plan{id:id.clone(),identity:identity.into(),cwd:cwd.to_string_lossy().into_owned(),kind:"build".into(),executable:String::new(),fingerprint:source_fingerprint(&cwd.canonicalize().unwrap()).unwrap(),approved:true};let out=output(root,&plan,&cwd.canonicalize().unwrap()).unwrap();let dir=directory(&out,&["graphify-out"]).unwrap();let mut graph=json!({"nodes":[{"id":"main","label":"main","source_file":"src/main.py","source_location":"L1","file_type":"code"},{"id":"greet","label":"greet","source_file":"src/helper.py","source_location":"L1","file_type":"code"},{"id":"other","label":"other","source_file":"src/helper.py","source_location":"L2","file_type":"code"}],"edges":[{"source":"main","target":"greet","relation":"calls","confidence":"EXTRACTED","source_file":"src/main.py","source_location":"L2"},{"source":"greet","target":"other","relation":"references","confidence":"INFERRED"}]});if clustered{graph["links"]=graph["edges"].clone();graph.as_object_mut().unwrap().remove("edges");graph["graph"]=json!({"schema_version":1,"graphify_version":ENGINE_VERSION});}let bytes=serde_json::to_vec(&graph).unwrap();fs::write(dir.join("graph.json"),&bytes).unwrap();fs::write(dir.join(".graphify_root"),&plan.cwd).unwrap();write(&scope(root,identity,&cwd.canonicalize().unwrap()).unwrap().join("current.json"),&Cache{identity:identity.into(),cwd:cwd_id(&cwd.canonicalize().unwrap()),plan_id:id.clone(),fingerprint:plan.fingerprint,graph_hash:hash(&bytes)}).unwrap();id}
    #[test]fn actual_graph_formats_and_two_hop_relationships_are_read(){let (root,agent,cwd)=fixture();for clustered in [false,true]{seed(&agent,"owner",&cwd,clustered);let info=inspect(&agent,"owner",cwd.to_str().unwrap()).unwrap();assert_eq!(info["state"],"ready");assert_eq!(info["graph"]["nodes"],3);let result=query(&agent,"owner",cwd.to_str().unwrap(),"main",1).unwrap();assert_eq!(result["matches"][0]["id"],"main");assert_eq!(result["relations"].as_array().unwrap().len(),2);assert_eq!(result["relations"][0]["confidence"],"EXTRACTED");assert_eq!(result["relations"][0]["source_location"],"L2");}fs::remove_dir_all(root).unwrap();}
    #[test]fn source_edits_additions_deletions_and_route_isolation_invalidate_graph(){let(root,agent,cwd)=fixture();seed(&agent,"a",&cwd,false);assert_eq!(inspect(&agent,"b",cwd.to_str().unwrap()).unwrap()["state"],"missing");fs::write(cwd.join("src/helper.py"),"def greet(): return 'changed'\n").unwrap();assert_eq!(query(&agent,"a",cwd.to_str().unwrap(),"greet",4).unwrap()["state"],"stale");seed(&agent,"a",&cwd,false);fs::write(cwd.join("src/new.py"),"x=1").unwrap();assert_eq!(inspect(&agent,"a",cwd.to_str().unwrap()).unwrap()["state"],"stale");seed(&agent,"a",&cwd,false);fs::remove_file(cwd.join("src/new.py")).unwrap();assert_eq!(inspect(&agent,"a",cwd.to_str().unwrap()).unwrap()["state"],"stale");fs::remove_dir_all(root).unwrap();}
    #[test]fn invalid_graph_paths_schema_and_endpoint_are_rejected(){let(root,_,cwd)=fixture();let cwd=cwd.canonicalize().unwrap();let path=root.join("graph.json");let graph=json!({"nodes":[{"id":"one","source_file":"../outside.py"}],"edges":[]});fs::write(&path,graph.to_string()).unwrap();assert!(load_graph(&path,&cwd).is_err());let graph=json!({"nodes":[{"id":"one","source_file":"src/main.py"}],"edges":[],"graph":{"schema_version":2}});fs::write(&path,graph.to_string()).unwrap();assert!(load_graph(&path,&cwd).is_err());let graph=json!({"nodes":[{"id":"one","source_file":"src/main.py"}],"edges":[{"source":"one","target":"missing"}]});fs::write(&path,graph.to_string()).unwrap();assert!(load_graph(&path,&cwd).is_err());assert!(plan_path(&root,"../other").is_err());fs::remove_dir_all(root).unwrap();}
    #[test]fn installation_must_be_explicitly_approved_by_its_identity(){let(root,agent,cwd)=fixture();let id=uuid::Uuid::new_v4().to_string();let plan=Plan{id:id.clone(),identity:"owner".into(),cwd:cwd.to_string_lossy().into_owned(),kind:"install".into(),executable:"never-run".into(),fingerprint:String::new(),approved:false};write(&plan_path(&agent,&id).unwrap(),&plan).unwrap();assert!(apply_build(&agent,&id).unwrap_err().contains("confirmation"));assert!(approve_install(&agent,"other",&id).is_err());approve_install(&agent,"owner",&id).unwrap();assert!(load_plan(&agent,&id).unwrap().approved);assert!(plan_result(&agent,"other",&id).is_err());assert_eq!(argv(&plan,Path::new("")),vec!["tool","install","graphifyy==0.9.85"]);fs::remove_dir_all(root).unwrap();}
    #[test]fn dependency_commands_and_query_context_are_bounded(){let(root,agent,cwd)=fixture();let id=seed(&agent,"owner",&cwd,false);let plan=Plan{id,identity:"owner".into(),cwd:cwd.to_string_lossy().into_owned(),kind:"build".into(),executable:String::new(),fingerprint:String::new(),approved:true};let args=argv(&plan,&agent);assert!(args.contains(&"--code-only".into()));assert!(args.contains(&"--no-cluster".into()));assert!(!args.contains(&"--cargo".into()));assert!(query(&agent,"owner",cwd.to_str().unwrap(),"",1).is_err());assert!(query(&agent,"owner",cwd.to_str().unwrap(),&"a".repeat(501),1).is_err());assert!(query(&agent,"owner",cwd.to_str().unwrap(),"main",usize::MAX).unwrap().to_string().len()<=MAX_CONTEXT);fs::remove_dir_all(root).unwrap();}
    fn git(cwd:&Path,args:&[&str]) {let mut command=Command::new("git");command.args(["-C",cwd.to_str().unwrap()]).args(args);#[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}assert!(command.output().unwrap().status.success());}
    #[test]fn git_head_and_current_code_are_checked_but_ignored_sources_are_pruned(){let(root,_,cwd)=fixture();git(&cwd,&["init","-b","main"]);git(&cwd,&["config","user.name","Coffee Test"]);git(&cwd,&["config","user.email","coffee-test@example.invalid"]);fs::write(cwd.join(".gitignore"),"cache/\n").unwrap();git(&cwd,&["add","."]);git(&cwd,&["commit","-m","initial"]);let cwd=cwd.canonicalize().unwrap();let first=source_fingerprint(&cwd).unwrap();fs::create_dir(cwd.join("cache")).unwrap();fs::write(cwd.join("cache/private.py"),"ignored-source").unwrap();assert_eq!(source_fingerprint(&cwd).unwrap(),first);git(&cwd,&["commit","--allow-empty","-m","new head"]);assert_ne!(source_fingerprint(&cwd).unwrap(),first);fs::write(cwd.join(".graphifyignore"),"src/helper.py\n").unwrap();let before=source_fingerprint(&cwd).unwrap();fs::write(cwd.join("src/helper.py"),"graphify-ignored-change").unwrap();assert_eq!(source_fingerprint(&cwd).unwrap(),before);fs::remove_dir_all(root).unwrap();}
    #[test]fn directory_ignore_batches_keep_sibling_sources_and_prune_nested_ignored_trees(){
        let(root,_,cwd)=fixture();git(&cwd,&["init","-b","main"]);
        fs::write(cwd.join(".gitignore"),"ignored-project-*/\ncomponents/*/private/\n").unwrap();
        for index in 0..100 {
            let component=cwd.join(format!("components/item-{index}"));fs::create_dir_all(&component).unwrap();
            fs::write(component.join("main.py"),format!("value = {index}\n")).unwrap();
            let ignored=cwd.join(format!("ignored-project-{index}/deep/nested"));fs::create_dir_all(&ignored).unwrap();
            fs::write(ignored.join("huge.py"),"ignored source\n").unwrap();
            if index == 0 { fs::File::options().write(true).open(ignored.join("huge.py")).unwrap().set_len(MAX_SOURCE_BYTES as u64+1).unwrap(); }
            let private=component.join("private/nested");fs::create_dir_all(&private).unwrap();
            fs::write(private.join("huge.py"),"ignored nested source\n").unwrap();
        }
        let canonical=cwd.canonicalize().unwrap();let first=source_fingerprint(&canonical).unwrap();
        fs::write(cwd.join("ignored-project-0/deep/nested/huge.py"),"ignored edit").unwrap();
        fs::write(cwd.join("components/item-0/private/nested/huge.py"),"ignored nested edit").unwrap();
        assert_eq!(source_fingerprint(&canonical).unwrap(),first);
        fs::write(cwd.join("components/item-99/main.py"),"value = 'changed'\n").unwrap();
        assert_ne!(source_fingerprint(&canonical).unwrap(),first);fs::remove_dir_all(root).unwrap();
    }
    #[test]fn graph_budgets_and_tampered_cache_never_return_fresh_evidence(){let(root,agent,cwd)=fixture();let id=seed(&agent,"owner",&cwd,false);let base=scope(&agent,"owner",&cwd.canonicalize().unwrap()).unwrap();fs::write(base.join("runs").join(id).join("graphify-out/graph.json"),"{}").unwrap();assert!(inspect(&agent,"owner",cwd.to_str().unwrap()).is_err());let path=root.join("large.json");let file=fs::File::create(&path).unwrap();file.set_len(MAX_GRAPH_BYTES as u64+1).unwrap();assert!(load_graph(&path,&cwd.canonicalize().unwrap()).unwrap_err().contains("budget"));fs::remove_dir_all(root).unwrap();}
    #[test]fn absent_cache_is_missing_but_non_file_metadata_is_rejected(){
        let(root,agent,cwd)=fixture();assert_eq!(inspect(&agent,"owner",cwd.to_str().unwrap()).unwrap()["state"],"missing");
        let base=scope(&agent,"owner",&cwd.canonicalize().unwrap()).unwrap();fs::create_dir(base.join("current.json")).unwrap();
        assert!(inspect(&agent,"owner",cwd.to_str().unwrap()).is_err());fs::remove_dir_all(root).unwrap();
    }
    #[test]fn authentication_source_is_in_scope_but_credentials_are_not(){let(root,_,cwd)=fixture();assert!(!blocked("tokenizer.py"));assert!(!blocked("password-reset.ts"));assert!(!blocked("secret.ts"));assert!(blocked("credentials.json"));assert!(blocked("api-token.yaml"));let before=source_fingerprint(&cwd.canonicalize().unwrap()).unwrap();fs::write(cwd.join("tokenizer.py"),"def tokenize(): return []\n").unwrap();assert_ne!(source_fingerprint(&cwd.canonicalize().unwrap()).unwrap(),before);fs::remove_dir_all(root).unwrap();}
    #[test]fn saved_project_understanding_refreshes_when_graph_sources_change(){let(root,agent,cwd)=fixture();seed(&agent,"owner",&cwd,false);let first=crate::agent_projects::project_inspect(&agent,"owner",cwd.to_str().unwrap(),false).unwrap();assert_eq!(first["graphify"]["state"],"ready");crate::agent_projects::project_save(&agent,"owner",cwd.to_str().unwrap(),first["fingerprint"].as_str().unwrap(),"main calls greet; Graphify source locations verified",None).unwrap();assert_eq!(crate::agent_projects::project_inspect(&agent,"owner",cwd.to_str().unwrap(),false).unwrap()["needsUpdate"],false);assert_eq!(prepare_build(&agent,"owner",cwd.to_str().unwrap(),false).unwrap()["state"],"ready");fs::write(cwd.join("src/helper.py"),"def greet(): return 'new behavior'\n").unwrap();let changed=crate::agent_projects::project_inspect(&agent,"owner",cwd.to_str().unwrap(),false).unwrap();assert_eq!(changed["graphify"]["state"],"stale");assert_eq!(changed["needsUpdate"],true);assert!(crate::agent_projects::project_save(&agent,"owner",cwd.to_str().unwrap(),first["fingerprint"].as_str().unwrap(),"old graph",None).is_err());fs::remove_dir_all(root).unwrap();}
    #[test]fn already_stale_graph_still_invalidates_notes_after_another_source_edit(){
        let(root,agent,cwd)=fixture();seed(&agent,"owner",&cwd,false);
        fs::write(cwd.join("src/helper.py"),"def greet(): return 'first change'\n").unwrap();
        let first=crate::agent_projects::project_inspect(&agent,"owner",cwd.to_str().unwrap(),false).unwrap();
        assert_eq!(first["graphify"]["state"],"stale");
        crate::agent_projects::project_save(&agent,"owner",cwd.to_str().unwrap(),first["fingerprint"].as_str().unwrap(),"Graph is stale; first source change observed",None).unwrap();
        assert_eq!(crate::agent_projects::project_inspect(&agent,"owner",cwd.to_str().unwrap(),false).unwrap()["needsUpdate"],false);
        fs::write(cwd.join("src/helper.py"),"def greet(): return 'second change'\n").unwrap();
        let second=crate::agent_projects::project_inspect(&agent,"owner",cwd.to_str().unwrap(),false).unwrap();
        assert_eq!(second["graphify"]["state"],"stale");assert_eq!(second["needsUpdate"],true);
        assert_eq!(first["graphify"]["sourceFingerprint"],second["graphify"]["sourceFingerprint"]);
        assert_ne!(first["graphify"]["currentSourceFingerprint"],second["graphify"]["currentSourceFingerprint"]);
        assert!(crate::agent_projects::project_save(&agent,"owner",cwd.to_str().unwrap(),first["fingerprint"].as_str().unwrap(),"Outdated first change",None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]fn analysis_plans_require_real_directories_and_an_external_cache(){let(root,agent,cwd)=fixture();assert!(prepare_build(&agent,"owner","relative",false).is_err());let internal=cwd.join("coffee-cache");assert!(prepare_build(&internal,"owner",cwd.to_str().unwrap(),false).unwrap_err().contains("outside"));assert!(!internal.exists());fs::remove_dir_all(root).unwrap();}
    #[cfg(unix)]#[test]fn aliased_parent_cannot_create_a_missing_cache_inside_the_project(){
        let(root,_,cwd)=fixture();let alias=root.join("workspace-alias");
        std::os::unix::fs::symlink(cwd.canonicalize().unwrap(),&alias).unwrap();
        let internal=alias.join("not-created/nested-cache");
        assert!(prepare_build(&internal,"owner",cwd.to_str().unwrap(),false).unwrap_err().contains("outside"));
        assert!(prepare_install(&internal,"owner",cwd.to_str().unwrap()).unwrap_err().contains("outside"));
        assert!(!cwd.join("not-created").exists());fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]#[test]fn source_and_cache_symlinks_are_rejected(){let(root,agent,cwd)=fixture();std::os::unix::fs::symlink(root.join("private.py"),cwd.join("src/link.py")).unwrap();assert!(source_path(&cwd.canonicalize().unwrap(),"src/link.py").is_err());let base=scope(&agent,"owner",&cwd.canonicalize().unwrap()).unwrap();std::os::unix::fs::symlink(root.join("outside.json"),base.join("current.json")).unwrap();assert!(inspect(&agent,"owner",cwd.to_str().unwrap()).is_err());fs::remove_dir_all(root).unwrap();}
}
