use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// Modelo de dados
// ---------------------------------------------------------------------------

/// Representa uma tarefa no sistema.
/// `Serialize` + `Deserialize` permite envio via invoke (JSON) e persistência.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Task {
    pub id: u32,
    pub title: String,
    pub description: String,
    pub completed: bool,
    /// Timestamp Unix em milissegundos (gerado pelo Rust para evitar divergências de fuso).
    pub created_at: u64,
}

// ---------------------------------------------------------------------------
// Estado global da aplicação
// ---------------------------------------------------------------------------

/// Mantido em memória durante toda a execução.
/// `Mutex` garante acesso exclusivo entre chamadas concorrentes de comandos Tauri.
pub struct AppState {
    pub tasks: Mutex<Vec<Task>>,
    pub next_id: Mutex<u32>,
}

// ---------------------------------------------------------------------------
// Helpers de persistência
// ---------------------------------------------------------------------------

fn tasks_file_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("Não foi possível obter o diretório de dados da aplicação")
        .join("tasks.json")
}

/// Lê as tarefas do arquivo JSON. Retorna lista vazia se o arquivo não existir.
fn load_tasks(app: &AppHandle) -> (Vec<Task>, u32) {
    let path = tasks_file_path(app);
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<Vec<Task>>(&content) {
                Ok(tasks) => {
                    let next_id =
                        tasks.iter().map(|t| t.id).max().map(|m| m + 1).unwrap_or(1);
                    return (tasks, next_id);
                }
                Err(e) => {
                    eprintln!(
                        "[todo-tauri] Aviso: falha ao deserializar tasks.json ({e}). \
                         Iniciando com lista vazia."
                    );
                }
            },
            Err(e) => {
                eprintln!(
                    "[todo-tauri] Aviso: não foi possível ler tasks.json ({e}). \
                     Iniciando com lista vazia."
                );
            }
        }
    }
    (Vec::new(), 1)
}

/// Persiste todas as tarefas em disco de forma atômica (write + rename seria
/// ideal, mas para simplicidade do Sprint 1 usamos write direto).
fn persist_tasks(app: &AppHandle, tasks: &[Task]) {
    let path = tasks_file_path(app);
    if let Some(parent) = path.parent() {
        // Cria o diretório se não existir (primeira execução).
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(tasks).unwrap_or_default();
    let _ = std::fs::write(&path, json);
}

/// Retorna o timestamp atual em milissegundos desde a Época Unix.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---------------------------------------------------------------------------
// Comandos Tauri (expostos ao frontend via invoke)
// ---------------------------------------------------------------------------

/// Retorna todas as tarefas em ordem de criação.
#[tauri::command]
fn get_tasks(state: State<AppState>) -> Vec<Task> {
    state.tasks.lock().expect("mutex envenenado").clone()
}

/// Cria uma nova tarefa. Retorna a tarefa criada ou um erro descritivo.
#[tauri::command]
fn add_task(
    app: AppHandle,
    title: String,
    description: String,
    state: State<AppState>,
) -> Result<Task, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("O título da tarefa não pode ser vazio.".into());
    }

    let mut tasks = state.tasks.lock().expect("mutex envenenado");
    let mut next_id = state.next_id.lock().expect("mutex envenenado");

    let task = Task {
        id: *next_id,
        title,
        description: description.trim().to_string(),
        completed: false,
        created_at: now_millis(),
    };

    *next_id += 1;
    tasks.push(task.clone());
    persist_tasks(&app, &tasks);
    Ok(task)
}

/// Atualiza título, descrição e status de uma tarefa existente.
#[tauri::command]
fn update_task(
    app: AppHandle,
    id: u32,
    title: String,
    description: String,
    completed: bool,
    state: State<AppState>,
) -> Result<Task, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("O título da tarefa não pode ser vazio.".into());
    }

    let mut tasks = state.tasks.lock().expect("mutex envenenado");
    let task = tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("Tarefa com id={id} não encontrada."))?;

    task.title = title;
    task.description = description.trim().to_string();
    task.completed = completed;

    let updated = task.clone();
    persist_tasks(&app, &tasks);
    Ok(updated)
}

/// Remove uma tarefa pelo ID.
#[tauri::command]
fn delete_task(app: AppHandle, id: u32, state: State<AppState>) -> Result<(), String> {
    let mut tasks = state.tasks.lock().expect("mutex envenenado");
    let len_before = tasks.len();
    tasks.retain(|t| t.id != id);

    if tasks.len() == len_before {
        return Err(format!("Tarefa com id={id} não encontrada."));
    }

    persist_tasks(&app, &tasks);
    Ok(())
}

/// Inverte o campo `completed` de uma tarefa (toggle).
#[tauri::command]
fn toggle_task(app: AppHandle, id: u32, state: State<AppState>) -> Result<Task, String> {
    let mut tasks = state.tasks.lock().expect("mutex envenenado");
    let task = tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("Tarefa com id={id} não encontrada."))?;

    task.completed = !task.completed;
    let updated = task.clone();
    persist_tasks(&app, &tasks);
    Ok(updated)
}

// ---------------------------------------------------------------------------
// Entry point da biblioteca
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let (tasks, next_id) = load_tasks(&app.handle().clone());
            app.manage(AppState {
                tasks: Mutex::new(tasks),
                next_id: Mutex::new(next_id),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_tasks,
            add_task,
            update_task,
            delete_task,
            toggle_task,
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar a aplicação Tauri");
}
