/**
 * main.js — Todo-Tauri (Sprint 1)
 *
 * Arquitetura: IIFE com três camadas:
 *   1. api       — thin wrapper sobre window.__TAURI__.core.invoke
 *   2. state     — filtro ativo + lista em memória (espelho do backend)
 *   3. ui        — funções de renderização (DOM manipulation, SEM innerHTML
 *                  para conteúdo do usuário — prevenção de XSS)
 *
 * Decisão de segurança: todo texto de usuário é inserido via
 * `element.textContent`, nunca via `innerHTML`. Isso garante que
 * caracteres como <, > e " nunca sejam interpretados como HTML.
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // Camada 1 — API (comunicação com o Rust via Tauri invoke)
  // -------------------------------------------------------------------------

  /**
   * O Tauri v2 expõe `window.__TAURI__` quando `withGlobalTauri: true` está
   * configurado em tauri.conf.json. `invoke` serializa args para JSON e
   * desserializa a resposta, funcionando como uma RPC segura sobre IPC.
   */
  const { invoke } = window.__TAURI__.core;

  const api = {
    getTasks:   ()                             => invoke("get_tasks"),
    addTask:    (title, description)           => invoke("add_task",    { title, description }),
    updateTask: (id, title, description, completed) =>
                                                  invoke("update_task", { id, title, description, completed }),
    deleteTask: (id)                           => invoke("delete_task", { id }),
    toggleTask: (id)                           => invoke("toggle_task", { id }),
  };

  // -------------------------------------------------------------------------
  // Camada 2 — Estado local
  // -------------------------------------------------------------------------

  const state = {
    tasks:  [],        // cópia local sincronizada com o backend
    filter: "all",     // "all" | "active" | "completed"
  };

  function filteredTasks() {
    switch (state.filter) {
      case "active":    return state.tasks.filter(t => !t.completed);
      case "completed": return state.tasks.filter(t =>  t.completed);
      default:          return state.tasks;
    }
  }

  // -------------------------------------------------------------------------
  // Camada 3 — UI helpers (criação de elementos sem innerHTML)
  // -------------------------------------------------------------------------

  /** Formata um timestamp Unix (ms) para data/hora locale pt-BR. */
  function formatDate(ms) {
    return new Date(ms).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  /**
   * Cria o elemento <li> de uma tarefa.
   * SEGURANÇA: todos os campos de texto do usuário são atribuídos via
   * `textContent`, nunca via `innerHTML`, eliminando vetores de XSS.
   */
  function buildTaskElement(task) {
    const li = document.createElement("li");
    li.className = "task-item" + (task.completed ? " is-completed" : "");
    li.dataset.taskId = task.id;

    // Checkbox para toggle
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "task-checkbox";
    checkbox.checked = task.completed;
    checkbox.setAttribute("aria-label", "Marcar como " + (task.completed ? "ativa" : "concluída"));

    // Conteúdo textual
    const body = document.createElement("div");
    body.className = "task-body";

    const titleEl = document.createElement("div");
    titleEl.className = "task-title";
    titleEl.textContent = task.title;          // ← textContent (seguro)

    body.appendChild(titleEl);

    if (task.description) {
      const descEl = document.createElement("p");
      descEl.className = "task-description";
      descEl.textContent = task.description;   // ← textContent (seguro)
      body.appendChild(descEl);
    }

    const metaEl = document.createElement("p");
    metaEl.className = "task-meta";
    metaEl.textContent = formatDate(task.created_at);
    body.appendChild(metaEl);

    // Botões de ação
    const actions = document.createElement("div");
    actions.className = "task-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "btn-icon btn-icon--edit";
    editBtn.type = "button";
    editBtn.textContent = "✏️";
    editBtn.setAttribute("aria-label", "Editar tarefa");
    editBtn.dataset.action = "edit";
    editBtn.dataset.taskId = task.id;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-icon btn-icon--delete";
    deleteBtn.type = "button";
    deleteBtn.textContent = "🗑️";
    deleteBtn.setAttribute("aria-label", "Excluir tarefa");
    deleteBtn.dataset.action = "delete";
    deleteBtn.dataset.taskId = task.id;

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    li.appendChild(checkbox);
    li.appendChild(body);
    li.appendChild(actions);

    return li;
  }

  // -------------------------------------------------------------------------
  // Renderização
  // -------------------------------------------------------------------------

  function render() {
    const list        = document.getElementById("task-list");
    const emptyMsg    = document.getElementById("empty-message");
    const taskCount   = document.getElementById("task-count");
    const tasks       = filteredTasks();

    // Limpa a lista de forma eficiente.
    list.replaceChildren();

    tasks.forEach(task => list.appendChild(buildTaskElement(task)));

    emptyMsg.hidden = tasks.length > 0;

    const activeCount = state.tasks.filter(t => !t.completed).length;
    taskCount.textContent =
      activeCount === 0
        ? "Todas concluídas 🎉"
        : `${activeCount} ativa${activeCount !== 1 ? "s" : ""}`;
  }

  // -------------------------------------------------------------------------
  // Gerenciamento de erros inline nos formulários
  // -------------------------------------------------------------------------

  function showError(elementId, message) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = message;
  }

  function clearError(elementId) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = "";
  }

  // -------------------------------------------------------------------------
  // Handlers — Formulário de Adição
  // -------------------------------------------------------------------------

  function initAddForm() {
    const form    = document.getElementById("form-add-task");
    const titleIn = document.getElementById("input-title");
    const descIn  = document.getElementById("input-description");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearError("form-error");

      const title = titleIn.value.trim();
      const desc  = descIn.value.trim();

      if (!title) {
        showError("form-error", "O título é obrigatório.");
        titleIn.focus();
        return;
      }

      try {
        const newTask = await api.addTask(title, desc);
        state.tasks.push(newTask);
        titleIn.value = "";
        descIn.value  = "";
        render();
        titleIn.focus();
      } catch (err) {
        showError("form-error", String(err));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Handlers — Modal de Edição
  // -------------------------------------------------------------------------

  let editingTaskId = null;

  function openEditModal(task) {
    editingTaskId = task.id;

    document.getElementById("edit-title").value       = task.title;
    document.getElementById("edit-description").value = task.description;
    document.getElementById("edit-completed").checked = task.completed;
    clearError("edit-error");

    document.getElementById("edit-modal").showModal();
    document.getElementById("edit-title").focus();
  }

  function initEditModal() {
    const modal     = document.getElementById("edit-modal");
    const form      = document.getElementById("form-edit-task");
    const cancelBtn = document.getElementById("btn-cancel-edit");

    cancelBtn.addEventListener("click", () => {
      modal.close();
      editingTaskId = null;
    });

    // Fechar ao clicar no backdrop (fora do modal)
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.close();
        editingTaskId = null;
      }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearError("edit-error");

      const title     = document.getElementById("edit-title").value.trim();
      const desc      = document.getElementById("edit-description").value.trim();
      const completed = document.getElementById("edit-completed").checked;

      if (!title) {
        showError("edit-error", "O título é obrigatório.");
        document.getElementById("edit-title").focus();
        return;
      }

      try {
        const updated = await api.updateTask(editingTaskId, title, desc, completed);
        const idx = state.tasks.findIndex(t => t.id === editingTaskId);
        if (idx !== -1) state.tasks[idx] = updated;
        modal.close();
        editingTaskId = null;
        render();
      } catch (err) {
        showError("edit-error", String(err));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Handlers — Lista (delegação de eventos para performance)
  // -------------------------------------------------------------------------

  function initTaskList() {
    const list = document.getElementById("task-list");

    /**
     * Event delegation: um único listener no <ul> gerencia cliques de todos
     * os botões filhos. Evita registrar N listeners para N tarefas.
     */
    list.addEventListener("click", async (e) => {
      const action = e.target.dataset.action;
      const taskId = parseInt(e.target.dataset.taskId, 10);

      if (!action || isNaN(taskId)) return;

      if (action === "edit") {
        const task = state.tasks.find(t => t.id === taskId);
        if (task) openEditModal(task);
      }

      if (action === "delete") {
        try {
          await api.deleteTask(taskId);
          state.tasks = state.tasks.filter(t => t.id !== taskId);
          render();
        } catch (err) {
          console.error("Erro ao excluir:", err);
        }
      }
    });

    list.addEventListener("change", async (e) => {
      if (!e.target.classList.contains("task-checkbox")) return;
      const li     = e.target.closest(".task-item");
      const taskId = parseInt(li?.dataset.taskId, 10);
      if (isNaN(taskId)) return;

      try {
        const updated = await api.toggleTask(taskId);
        const idx = state.tasks.findIndex(t => t.id === taskId);
        if (idx !== -1) state.tasks[idx] = updated;
        render();
      } catch (err) {
        // Reverte visualmente em caso de erro
        e.target.checked = !e.target.checked;
        console.error("Erro ao alternar tarefa:", err);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Handlers — Filtros
  // -------------------------------------------------------------------------

  function initFilters() {
    const bar = document.querySelector(".filter-bar");
    bar.addEventListener("click", (e) => {
      if (!e.target.classList.contains("filter-btn")) return;
      state.filter = e.target.dataset.filter;

      bar.querySelectorAll(".filter-btn").forEach(btn => {
        btn.classList.toggle("filter-btn--active", btn.dataset.filter === state.filter);
      });

      render();
    });
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  async function init() {
    try {
      state.tasks = await api.getTasks();
    } catch (err) {
      console.error("Erro ao carregar tarefas:", err);
      state.tasks = [];
    }

    initAddForm();
    initEditModal();
    initTaskList();
    initFilters();
    render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
