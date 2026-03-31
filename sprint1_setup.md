```md
# Sprint 1 — Setup: Do Zero à Base Funcional

## Objetivo do Sprint

Configurar o projeto Tauri v2 do zero, implementar o modelo de dados em Rust e
entregar um CRUD completo de tarefas com frontend em HTML5/CSS3/Vanilla JS.

---

## 1. Pré-requisitos

| Ferramenta   | Versão mínima | Instalação                                      |
|--------------|---------------|-------------------------------------------------|
| Rust         | 1.70+         | https://rustup.rs                               |
| Cargo        | 1.70+         | Incluído com Rust                               |
| Node.js      | 18+           | https://nodejs.org (opcional, apenas para CLI)  |
| Tauri CLI v2 | 2.x           | `cargo install tauri-cli --version "^2"`        |
| WebKit / GTK | —             | Linux: `sudo apt install libwebkit2gtk-4.1-dev` |

---

## 2. Estrutura de Arquivos (Sprint 1)

```
todo-tauri/
├── .gitignore                  [CRIADO]
├── README.md
├── sprint1_setup.md            [CRIADO]
├── src/                        [CRIADO]
│   ├── index.html              [CRIADO]
│   ├── styles.css              [CRIADO]
│   └── main.js                 [CRIADO]
└── src-tauri/                  [CRIADO]
    ├── Cargo.toml              [CRIADO]
    ├── build.rs                [CRIADO]
    ├── tauri.conf.json         [CRIADO]
    ├── capabilities/
    │   └── default.json        [CRIADO]
    └── src/
        ├── main.rs             [CRIADO]
        └── lib.rs              [CRIADO]
```

---

## 3. Como Executar

```bash
# Instalar dependências Rust e iniciar em modo dev
cargo tauri dev --manifest-path src-tauri/Cargo.toml
```

> **Primeira execução**: o Cargo baixará e compilará ~200 crates.
> Pode levar de 3 a 10 minutos. Compilações subsequentes são incrementais.

---

## 4. Raciocínio Arquitetural

### 4.1 Por que Tauri v2 em vez de Electron?

| Critério         | Tauri v2          | Electron         |
|------------------|-------------------|------------------|
| Tamanho do bundle| ~3–8 MB           | ~100+ MB         |
| Memória RAM      | ~30–50 MB         | ~150–400 MB      |
| Runtime          | WebView do SO     | Chromium embutido|
| Segurança        | IPC com ACL       | IPC mais aberto  |
| Linguagem backend| Rust (memory-safe)| Node.js/JS       |

O Tauri usa a **WebView nativa do sistema operacional** (WebKit no macOS/Linux,
WebView2 no Windows), eliminando a necessidade de empacotar um browser inteiro.
O backend em Rust garante **ausência de segfaults, buffer overflows e data races**
por design (o compilador rejeita código inseguro em tempo de compilação).

---

### 4.2 Modelo de Estado: `Mutex<Vec<Task>>`

```rust
pub struct AppState {
    pub tasks: Mutex<Vec<Task>>,
    pub next_id: Mutex<u32>,
}
```

- **Por que `Mutex`?** Os comandos Tauri podem ser chamados de forma
  concorrente pelo frontend (ex.: cliques rápidos). O `Mutex` garante que
  apenas uma thread acesse o vetor por vez, evitando _data races_.

- **Por que não `RwLock`?** Para um app de CRUD simples, as escritas são tão
  frequentes quanto as leituras. `RwLock` adicionaria complexidade sem ganho
  mensurável.

- **Por que `Vec<Task>` e não um banco de dados?** No Sprint 1, mantemos a
  dependência mínima. A persistência em JSON via `serde_json` é suficiente para
  dezenas ou centenas de tarefas. Em Sprints futuros, podemos migrar para SQLite
  (via `rusqlite` ou `sqlx`) sem alterar a API pública dos comandos.

---

### 4.3 Persistência: `std::fs` + `serde_json`

```rust
fn persist_tasks(app: &AppHandle, tasks: &[Task]) {
    let path = tasks_file_path(app);
    let json = serde_json::to_string_pretty(tasks).unwrap_or_default();
    let _ = std::fs::write(&path, json);
}
```

- O caminho `app_data_dir()` é resolvido pelo Tauri de acordo com a convenção
  de cada SO:
  - **Linux**: `~/.local/share/com.todo-tauri.app/tasks.json`
  - **macOS**: `~/Library/Application Support/com.todo-tauri.app/tasks.json`
  - **Windows**: `%APPDATA%\com.todo-tauri.app\tasks.json`

- **Escrita direta vs. atômica**: Usamos `std::fs::write` direto. Em Sprints
  futuros, para maior confiabilidade (resistência a falhas de energia),
  adotaremos o padrão _write-to-temp + rename_, que é atômico no POSIX.

---

### 4.4 Segurança no Frontend: `textContent` vs `innerHTML`

```javascript
// ✅ CORRETO — o valor é escapado automaticamente pelo DOM
titleEl.textContent = task.title;

// ❌ ERRADO — interpretaria <script>alert(1)</script> como HTML (XSS)
// titleEl.innerHTML = task.title;
```

Se um usuário criar uma tarefa com título `<img src=x onerror=alert(1)>`,
`textContent` a exibe literalmente como texto. `innerHTML` executaria o
handler JavaScript, configurando um vetor de **Cross-Site Scripting (XSS)**.

Embora o Tauri isole a WebView do sistema operacional, um XSS ainda pode
invocar comandos Tauri expostos, vazando dados ou causando ações indesejadas.
A defesa em profundidade exige sanitização mesmo em apps desktop.

---

### 4.5 Isolamento de Processos no Tauri

```
┌─────────────────────────────────┐
│  Processo Principal (Rust)      │
│  - Gerencia estado da aplicação │
│  - Acessa filesystem, SO        │
│  - Expõe comandos via IPC       │
└────────────┬────────────────────┘
             │  IPC (JSON serializado)
             │  Somente comandos registrados
             ▼
┌─────────────────────────────────┐
│  WebView (frontend JS)          │
│  - HTML/CSS/JS (sem Node.js)    │
│  - SEM acesso direto ao SO      │
│  - Chama invoke("comando", args)│
└─────────────────────────────────┘
```

O frontend **não tem acesso ao filesystem, rede ou APIs nativas** por padrão.
Cada funcionalidade deve ser explicitamente exposta via `tauri::generate_handler!`
e protegida por uma **Capability** (arquivo `capabilities/default.json`).
Isso limita drasticamente a superfície de ataque comparado a uma app web comum.

---

### 4.6 Event Delegation no JavaScript

```javascript
// ✅ Um listener para N tarefas (O(1) em memória)
list.addEventListener("click", (e) => {
    const action = e.target.dataset.action;
    ...
});

// ❌ N listeners para N tarefas (O(n) em memória e GC pressure)
// tasks.forEach(task => taskEl.addEventListener("click", handler));
```

Com event delegation, um único listener no `<ul>` pai captura cliques de todos
os botões filhos via **bubbling**. Isso é especialmente importante para listas
dinâmicas: os elementos removidos e recriados no DOM não deixam listeners
"zumbis" causando memory leaks.

---

## 5. Comandos Tauri Implementados

| Comando       | Parâmetros                              | Retorno          |
|---------------|-----------------------------------------|------------------|
| `get_tasks`   | —                                       | `Vec<Task>`      |
| `add_task`    | `title: String`, `description: String` | `Result<Task>`   |
| `update_task` | `id`, `title`, `description`, `completed` | `Result<Task>` |
| `delete_task` | `id: u32`                               | `Result<()>`     |
| `toggle_task` | `id: u32`                               | `Result<Task>`   |

Todos os comandos de escrita retornam `Result<T, String>` para propagar erros
ao frontend de forma explícita (sem panics silenciosos).

---

## 6. Próximos Sprints (Backlog)

- **Sprint 2**: Persistência robusta (write atômico) + SQLite com `rusqlite`
- **Sprint 3**: Filtros avançados + busca por texto + ordenação
- **Sprint 4**: Notificações nativas (`tauri-plugin-notification`)
- **Sprint 5**: Tray icon + execução em background
- **Sprint 6**: Build de produção + CI/CD com GitHub Actions + auto-update
```
