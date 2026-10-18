"use client";

/**
 * Project + document browser — the welcome surface when no doc is open.
 * Apple-grade: clean list, hairlines, no chrome.
 */

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useRouter } from "next/navigation";
import { getAuthHeaders } from "@/lib/use-session";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";
import ProjectTable from "@/components/project-table";
import FileTree from "@/components/file-tree";
import { renameFolderPrefix } from "@/lib/file-tree";

interface Project {
  id: string;
  name: string;
  ownerUid: string;
  description?: string | null;
  tags?: string[];
  archived?: boolean;
  memberCount?: number;
  ownerDisplayName?: string | null;
  updatedAt: number;
}
interface Document {
  id: string;
  projectId: string;
  fileId: string;
  title: string | null;
  updatedAt: number;
}
interface Member {
  subjectId: string;
  role: string;
  displayName: string | null;
  kind: string | null;
  status?: string | null;  // 'active' | 'disabled' | null
}
interface Contact {
  subjectId: string;
  uid: number;
  username: string;
  displayName: string;
  avatarUrl?: string;
  kind: "user" | "agent";
}
interface AgentSetup {
  subjectId: string;
  role: string;
  fileId: string;
  wsBaseUrl: string;
  roomName: string;
  instructions: string;
  envBlock: string;
}

/**
 * Open a document with a full navigation rather than the client router.
 *
 * Two gateway behaviours make client-side navigation unusable here, and both
 * were observed live:
 *   - `router.push("/?doc=…")` under basePath produces `/sumi?doc=…` (no
 *     trailing slash). The deployment's CSP allows `…/sumi/`, so Next's RSC
 *     fetch for that URL is refused and the router falls back to a page load.
 *   - The same slashless URL is also redirected by the gateway to `/sumi/`,
 *     which drops the query string — so the document never arrives and the
 *     workspace re-renders the list.
 *
 * Navigating to the explicitly slashed path avoids both: the query survives,
 * and the server sends the editor back.
 */
function openDocument(id: string): void {
  window.location.assign(apiPath(`/?doc=${encodeURIComponent(id)}`));
}

export default function DocumentListPane() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [showNewDoc, setShowNewDoc] = useState(false);
  const [newFileId, setNewFileId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [newMemberId, setNewMemberId] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<"viewer" | "editor">("editor");
  const [error, setError] = useState<string | null>(null);
  // Agent onboarding: which member's setup card is expanded
  const [agentSetupFor, setAgentSetupFor] = useState<string | null>(null);
  const [agentSetup, setAgentSetup] = useState<AgentSetup | null>(null);
  const [agentSetupFileId, setAgentSetupFileId] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
  const [confirmDeleteDoc, setConfirmDeleteDoc] = useState<string | null>(null);
  const [sessionSubjectId, setSessionSubjectId] = useState<string | null>(null);
  const [renamingDoc, setRenamingDoc] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameFileId, setRenameFileId] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [addMemberMode, setAddMemberMode] = useState<"picker" | "manual">("picker");
  const [busyActions, setBusyActions] = useState<Set<string>>(new Set());
  // list | table — persisted across sessions
  // From the store, so a `set_project_view` patch can switch it and the saved
  // preference travels the same path. See the note in workspace-shell about
  // chrome that lives in local state.
  const viewMode = useUiStore((s) => s.projectView);
  const setViewMode = useUiStore((s) => s.setProjectView);
  const [renamingProject, setRenamingProject] = useState(false);
  const [projectRenameValue, setProjectRenameValue] = useState("");

  useEffect(() => {
    const v = localStorage.getItem("sumi:proj-view");
    if (v === "table" || v === "list") setViewMode(v);
  }, []);

  const switchView = (v: "list" | "table") => {
    setViewMode(v);
    try {
      localStorage.setItem("sumi:proj-view", v);
    } catch {
      /* private mode */
    }
  };

  // Load projects + whoami on mount
  useEffect(() => {
    fetch(apiPath("/api/projects"), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => setProjects(d.projects || []))
      .catch(() => setProjects([]));
    fetch(apiPath("/api/auth/me"), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.actor?.id) setSessionSubjectId(d.actor.id);
      })
      .catch(() => {});
  }, []);

  // Load documents when a project is selected
  useEffect(() => {
    if (!selected) {
      setDocuments([]);
      return;
    }
    setLoadingDocs(true);
    fetch(apiPath(`/api/projects/${selected.id}/documents`), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { documents: [] }))
      .then((d) => setDocuments(d.documents || []))
      .catch(() => setDocuments([]))
      .finally(() => setLoadingDocs(false));
    setConfirmDeleteProject(false);
    setConfirmDeleteDoc(null);
  }, [selected]);

  // Load members when the members panel opens
  useEffect(() => {
    if (!selected || !showMembers) return;
    fetch(apiPath(`/api/projects/${selected.id}/members`), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => setMembers(d.members || []))
      .catch(() => setMembers([]));

    // Also load contacts (friends + bots) so the picker can render.
    setContactsLoading(true);
    fetch(apiPath("/api/friends"), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { users: [], agents: [] }))
      .then((d) => setContacts([...(d.users ?? []), ...(d.agents ?? [])]))
      .catch(() => setContacts([]))
      .finally(() => setContactsLoading(false));
  }, [selected, showMembers]);

  const isOwner = selected && sessionSubjectId && selected.ownerUid === sessionSubjectId;

  const withBusy = async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (busyActions.has(key)) return;
    setBusyActions((s) => new Set(s).add(key));
    try {
      return await fn();
    } finally {
      setBusyActions((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };

  const createProject = () => withBusy("create-project", async () => {
    if (!newProjectName.trim()) return;
    setError(null);
    const res = await fetch(apiPath("/api/projects"), {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: newProjectName.trim() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "failed");
      toast({ title: "创建项目失败", description: data.error, variant: "destructive" });
      return;
    }
    const { project } = await res.json();
    setProjects((p) => [project, ...p]);
    setNewProjectName("");
    setShowNewProject(false);
    setSelected(project);
    toast({ title: "项目已创建", description: project.name, variant: "success" });
  });

  const deleteProject = () => withBusy("delete-project", async () => {
    if (!selected) return;
    const res = await fetch(apiPath(`/api/projects/${selected.id}`), {
      method: "DELETE",
      headers: getAuthHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "failed");
      toast({ title: "删除项目失败", description: data.error, variant: "destructive" });
      return;
    }
    const name = selected.name;
    setProjects((p) => p.filter((x) => x.id !== selected.id));
    setSelected(null);
    setConfirmDeleteProject(false);
    toast({ title: "项目已删除", description: name, variant: "success" });
  });

  // --- Table-view callbacks -------------------------------------------------

  const patchProject = async (
    id: string,
    body: Record<string, unknown>
  ): Promise<Project | null> => {
    const res = await fetch(apiPath(`/api/projects/${id}`), {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast({
        title: "更新项目失败",
        description: data.error,
        variant: "destructive",
      });
      return null;
    }
    return (await res.json()).project as Project;
  };

  const renameProjectById = async (
    id: string,
    name: string
  ): Promise<Project | null> => {
    const key = `rename-${id}`;
    if (busyActions.has(key)) return null;
    setBusyActions((s) => new Set(s).add(key));
    try {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const next = await patchProject(id, { name: trimmed });
      if (next) {
        toast({ title: "已重命名", description: next.name, variant: "success" });
      }
      return next;
    } finally {
      setBusyActions((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  };

  const archiveProjectById = async (
    id: string,
    archived: boolean
  ): Promise<Project | null> => {
    const key = `archive-${id}`;
    if (busyActions.has(key)) return null;
    setBusyActions((s) => new Set(s).add(key));
    try {
      const next = await patchProject(id, { archived });
      if (next) {
        toast({
          title: archived ? "项目已归档" : "已取消归档",
          description: next.name,
          variant: "success",
        });
      }
      return next;
    } finally {
      setBusyActions((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  };

  const deleteProjectById = async (id: string): Promise<boolean> => {
    const key = `delete-${id}`;
    if (busyActions.has(key)) return false;
    setBusyActions((s) => new Set(s).add(key));
    try {
      const res = await fetch(apiPath(`/api/projects/${id}`), {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({
          title: "删除项目失败",
          description: data.error,
          variant: "destructive",
        });
        return false;
      }
      const name = projects.find((p) => p.id === id)?.name;
      toast({ title: "项目已删除", description: name, variant: "success" });
      return true;
    } finally {
      setBusyActions((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  };

  const handleProjectsRemoved = (ids: string[]) => {
    const idSet = new Set(ids);
    setProjects((p) => p.filter((x) => !idSet.has(x.id)));
    if (selected && idSet.has(selected.id)) setSelected(null);
  };

  const handleProjectUpdated = (next: Project) => {
    setProjects((p) => p.map((x) => (x.id === next.id ? next : x)));
    if (selected?.id === next.id) setSelected(next);
  };

  const saveProjectRename = async () => {
    if (!selected) return;
    const next = await renameProjectById(selected.id, projectRenameValue);
    if (next) handleProjectUpdated(next);
    setRenamingProject(false);
  };

  const createDocument = () => withBusy("create-doc", async () => {
    if (!selected || !newFileId.trim()) return;
    setError(null);
    const res = await fetch(apiPath(`/api/projects/${selected.id}/documents`), {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: newFileId.trim(),
        title: newTitle.trim() || undefined,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "failed");
      return;
    }
    const { document } = await res.json();
    setDocuments((d) => [document, ...d]);
    setNewFileId("");
    setNewTitle("");
    setShowNewDoc(false);
    toast({ title: "文档已创建", description: document.fileId, variant: "success" });
    openDocument(document.id);
  });

  const deleteDocument = async (doc: Document) => {
    if (!selected) return;
    const res = await fetch(apiPath(`/api/projects/${selected.id}/documents`), {
      method: "DELETE",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: doc.fileId }),
    });
    if (res.ok) {
      setDocuments((d) => d.filter((x) => x.id !== doc.id));
      toast({ title: "文档已删除", description: doc.fileId, variant: "success" });
    } else {
      const data = await res.json().catch(() => ({}));
      toast({ title: "删除失败", description: data.error, variant: "destructive" });
    }
    setConfirmDeleteDoc(null);
  };

  const startRename = (doc: Document) => {
    setRenamingDoc(doc.id);
    setRenameTitle(doc.title || "");
    setRenameFileId(doc.fileId);
  };

  // --- Folder ops (folders are derived from fileId slashes) ---------------

  const newDocInFolder = (folder: string | null) => {
    setShowNewDoc(true);
    setNewFileId(folder ? `${folder}/` : "");
  };

  const renameFolder = async (
    oldPath: string,
    newPath: string,
    docs: Document[]
  ) =>
    withBusy(`folder-rename-${oldPath}`, async () => {
      if (!selected || docs.length === 0) return;
      const results = await Promise.all(
        docs.map((doc) =>
          fetch(apiPath(`/api/projects/${selected.id}/documents`), {
            method: "PATCH",
            headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({
              fileId: doc.fileId,
              newFileId: renameFolderPrefix(doc.fileId, oldPath, newPath),
            }),
          }).then((r) => (r.ok ? r.json() : null))
        )
      );
      const ok = results.filter(Boolean).map((r) => r.document as Document);
      const byId = new Map(ok.map((d) => [d.id, d]));
      setDocuments((ds) => ds.map((d) => byId.get(d.id) ?? d));
      if (ok.length === docs.length) {
        toast({ title: "文件夹已重命名", description: newPath, variant: "success" });
      } else {
        toast({
          title: "部分文档重命名失败",
          description: `${ok.length}/${docs.length} 已更新`,
          variant: "destructive",
        });
      }
    });

  const deleteFolder = async (path: string, docs: Document[]) =>
    withBusy(`folder-delete-${path}`, async () => {
      if (!selected || docs.length === 0) return;
      const results = await Promise.all(
        docs.map((doc) =>
          fetch(apiPath(`/api/projects/${selected.id}/documents`), {
            method: "DELETE",
            headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ fileId: doc.fileId }),
          }).then((r) => (r.ok ? doc.id : null))
        )
      );
      const removed = new Set(results.filter(Boolean) as string[]);
      setDocuments((ds) => ds.filter((d) => !removed.has(d.id)));
      if (removed.size === docs.length) {
        toast({ title: "文件夹已删除", description: path, variant: "success" });
      } else {
        toast({
          title: "部分文档删除失败",
          description: `${removed.size}/${docs.length} 已删除`,
          variant: "destructive",
        });
      }
    });

  const saveRename = async () => {
    if (!selected || !renamingDoc) return;
    const doc = documents.find((d) => d.id === renamingDoc);
    if (!doc) return;
    const res = await fetch(apiPath(`/api/projects/${selected.id}/documents`), {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: doc.fileId,
        newFileId: renameFileId.trim() !== doc.fileId ? renameFileId.trim() : undefined,
        title: renameTitle.trim() || null,
      }),
    });
    if (res.ok) {
      const { document } = await res.json();
      setDocuments((d) =>
        d.map((x) => (x.id === renamingDoc ? document : x))
      );
      toast({ title: "已重命名", description: document.fileId, variant: "success" });
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "rename failed");
      toast({ title: "重命名失败", description: data.error, variant: "destructive" });
    }
    setRenamingDoc(null);
  };

  const addMember = async (subjectIdOverride?: string, roleOverride?: "viewer" | "editor") => {
    if (!selected) return;
    const subjectId = subjectIdOverride ?? newMemberId.trim();
    if (!subjectId) return;
    setError(null);
    const res = await fetch(apiPath(`/api/projects/${selected.id}/members`), {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        subjectId,
        role: roleOverride ?? newMemberRole,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "failed");
      toast({ title: "添加成员失败", description: data.error, variant: "destructive" });
      return;
    }
    setNewMemberId("");
    // Refresh list, and if it was an agent — auto-open the onboarding card
    fetch(apiPath(`/api/projects/${selected.id}/members`), { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => setMembers(d.members || []));
    if (subjectId.startsWith("a")) {
      toggleAgentSetup(subjectId);
    }
    toast({
      title: "成员已加入",
      description: subjectId,
      variant: "success",
    });

    // If it's a contact (not already a member), push the invite via CatsCo
    const isContact = contacts.some((c) => c.subjectId === subjectId);
    if (isContact && selected) {
      try {
        await fetch(apiPath("/api/friends"), {
          method: "POST",
          headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            subjectId,
            kind: subjectId.startsWith("a") ? "agent" : "user",
            projectId: selected.id,
            projectName: selected.name,
          }),
        });
      } catch {
        /* invite is best-effort — member is already added */
      }
    }
  };

  const removeMember = async (subjectId: string) => {
    if (!selected) return;
    const res = await fetch(apiPath(`/api/projects/${selected.id}/members`), {
      method: "DELETE",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ subjectId }),
    });
    if (res.ok) {
      setMembers((m) => m.filter((x) => x.subjectId !== subjectId));
      if (agentSetupFor === subjectId) {
        setAgentSetupFor(null);
        setAgentSetup(null);
      }
      toast({ title: "成员已移除", description: subjectId, variant: "success" });
    } else {
      const data = await res.json().catch(() => ({}));
      toast({ title: "移除失败", description: data.error, variant: "destructive" });
    }
  };

  const toggleAgentStatus = async (subjectId: string, currentStatus: string | null) => {
    if (!selected) return;
    const next = currentStatus === "disabled" ? "active" : "disabled";
    const res = await fetch(apiPath(`/api/projects/${selected.id}/members`), {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ subjectId, status: next }),
    });
    if (res.ok) {
      setMembers((m) =>
        m.map((x) =>
          x.subjectId === subjectId ? { ...x, status: next } : x
        )
      );
      toast({
        title: next === "disabled" ? "agent 已禁用" : "agent 已启用",
        description: subjectId,
        variant: "success",
      });
    } else {
      toast({ title: "操作失败", variant: "destructive" });
    }
  };

  const toggleAgentSetup = async (subjectId: string, fileId?: string) => {
    if (!selected) return;
    if (agentSetupFor === subjectId && fileId === undefined) {
      setAgentSetupFor(null);
      setAgentSetup(null);
      return;
    }
    setAgentSetupFor(subjectId);
    setAgentSetup(null);
    const targetFile = fileId ?? agentSetupFileId.trim();
    const params = targetFile
      ? `subjectId=${subjectId}&fileId=${encodeURIComponent(targetFile)}`
      : `subjectId=${subjectId}`;
    const res = await fetch(
      apiPath(`/api/projects/${selected.id}/agent-setup?${params}`),
      { headers: getAuthHeaders() }
    );
    if (res.ok) {
      const data = await res.json();
      setAgentSetup(data);
    }
  };

  const copyInstructions = async () => {
    if (!agentSetup) return;
    try {
      await navigator.clipboard.writeText(agentSetup.instructions);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast({ title: "接入指南已复制", variant: "success" });
    } catch {
      toast({ title: "复制失败", variant: "destructive" });
    }
  };

  const openDoc = (doc: Document) => {
    openDocument(doc.id);
  };

  return (
    <div className="flex h-full">
      {/* Sidebar — project list */}
      <aside className={cn(
        "shrink-0 border-r border-border/60 bg-sidebar text-sidebar-foreground",
        viewMode === "table" ? "w-[380px]" : "w-64"
      )}>
        <div className="flex h-11 items-center justify-between border-b border-border/60 px-4">
          <div className="flex items-center gap-2">
            <div className="text-[12px] font-medium text-muted-foreground">
              项目
            </div>
            {/* list / table pill toggle — persisted in localStorage */}
            <div className="flex items-center rounded-md border border-border/60 p-0.5">
              <button
                onClick={() => switchView("list")}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-medium",
                  viewMode === "list"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground"
                )}
                title="列表视图"
              >
                列表
              </button>
              <button
                onClick={() => switchView("table")}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-medium",
                  viewMode === "table"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground"
                )}
                title="表格视图"
              >
                表格
              </button>
            </div>
          </div>
          <button
            onClick={() => setShowNewProject(true)}
            className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            + 新建
          </button>
        </div>
        <div className="overflow-auto">
          {showNewProject && (
            <div className="border-b border-border/60 p-3">
                  <input
                    autoFocus
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createProject();
                      if (e.key === "Escape") setShowNewProject(false);
                    }}
                    placeholder="项目名称"
                    disabled={busyActions.has("create-project")}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                  />
            </div>
          )}
          {viewMode === "table" ? (
            <ProjectTable
              projects={projects}
              sessionSubjectId={sessionSubjectId}
              selectedId={selected?.id ?? null}
              busy={busyActions}
              onOpen={setSelected}
              onRename={renameProjectById}
              onDelete={deleteProjectById}
              onArchive={archiveProjectById}
              onRemoved={handleProjectsRemoved}
              onUpdated={handleProjectUpdated}
            />
          ) : (
            <>
              {projects.filter((p) => !p.archived).map((p) => (
                <div
                  key={p.id}
                  className={cn(
                    "group flex items-center justify-between px-4 py-2.5 text-[13px] transition-colors",
                    selected?.id === p.id
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/50"
                  )}
                >
                  <button onClick={() => setSelected(p)} className="flex-1 text-left">
                    {p.name}
                  </button>
                  {sessionSubjectId === p.ownerUid && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(p);
                        setConfirmDeleteProject(true);
                      }}
                      className="ml-2 hidden text-[10px] text-muted-foreground/70 hover:text-destructive group-hover:inline"
                      title="删除项目"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
          {projects.length === 0 && !showNewProject && (
            <div className="flex flex-col items-center p-8 text-center">
              <div className="text-[13px] font-medium text-foreground">
                还没有项目
              </div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                创建第一个项目开始协作
              </div>
              <button
                onClick={() => setShowNewProject(true)}
                className="mt-4 rounded-md bg-primary px-4 py-1.5 text-[12px] font-medium text-primary-foreground"
              >
                新建项目
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main — document list for selected project */}
      <main className="flex-1 overflow-auto">
        {!selected ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="text-[15px] font-medium text-foreground">
                选择一个项目查看文档
              </div>
              <div className="mt-1 text-[13px] text-muted-foreground">
                或在左侧新建一个项目
              </div>
            </div>
          </div>
        ) : (
          <>
            <header className="flex h-11 items-center justify-between border-b border-border/60 px-4">
              <div className="flex items-center gap-2">
                {renamingProject ? (
                  <input
                    autoFocus
                    value={projectRenameValue}
                    onChange={(e) => setProjectRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveProjectRename();
                      if (e.key === "Escape") setRenamingProject(false);
                    }}
                    onBlur={saveProjectRename}
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-[13px] font-medium outline-none focus:ring-1 focus:ring-primary"
                  />
                ) : (
                  <>
                    <div className="text-[13px] font-medium">{selected.name}</div>
                    {isOwner && (
                      <button
                        onClick={() => {
                          setProjectRenameValue(selected.name);
                          setRenamingProject(true);
                        }}
                        className="text-[10px] text-muted-foreground/60 hover:text-foreground"
                        title="重命名项目"
                      >
                        ✎
                      </button>
                    )}
                    {selected.archived && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                        已归档
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowMembers((v) => !v)}
                  className={cn(
                    "text-[11px] transition-colors",
                    showMembers
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  成员
                </button>
                <button
                  onClick={() => setShowNewDoc(true)}
                  className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  + 新建文档
                </button>
              </div>
            </header>

            {/* Confirm delete project */}
            {confirmDeleteProject && (
              <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-[12px] text-destructive">
                    删除项目「{selected.name}」会同时删除其所有文档和成员关系。
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmDeleteProject(false)}
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      取消
                    </button>
                    <button
                      onClick={deleteProject}
                      disabled={busyActions.has("delete-project")}
                      className="rounded-md bg-destructive px-3 py-1 text-[11px] font-medium text-destructive-foreground disabled:opacity-50"
                    >
                      {busyActions.has("delete-project") ? "删除中…" : "确认删除"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Members panel */}
            {showMembers && (
              <div className="border-b border-border/60 bg-accent/20 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[12px] font-medium text-muted-foreground">
                    成员（{members.length}）
                  </div>
                </div>
                <ul className="mb-3 divide-y divide-border/40">
                  {members.map((m) => {
                    const isAgent = m.subjectId.startsWith("a") || m.kind === "agent";
                    const isDisabled = m.status === "disabled";
                    const setupOpen = agentSetupFor === m.subjectId;
                    return (
                      <li key={m.subjectId} className={cn("py-2", isDisabled && "opacity-50")}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white",
                              isDisabled
                                ? "bg-muted-foreground/40"
                                : isAgent ? "bg-violet-500" : "bg-primary"
                            )}>
                              {(m.displayName || m.subjectId).slice(0, 1).toUpperCase()}
                            </span>
                            <div>
                              <div className="text-[12px] font-medium">
                                {m.displayName || m.subjectId}
                                {isAgent && (
                                  <span className="ml-1.5 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-600">
                                    agent
                                  </span>
                                )}
                                {isDisabled && (
                                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                                    已禁用
                                  </span>
                                )}
                              </div>
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {m.subjectId} · {m.role}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {isAgent && (
                              <>
                                <button
                                  onClick={() => toggleAgentSetup(m.subjectId)}
                                  className={cn(
                                    "text-[11px]",
                                    setupOpen
                                      ? "text-foreground"
                                      : "text-muted-foreground hover:text-foreground"
                                  )}
                                >
                                  {setupOpen ? "收起接入指南" : "接入指南"}
                                </button>
                                {isOwner && (
                                  <button
                                    onClick={() => toggleAgentStatus(m.subjectId, m.status ?? null)}
                                    className="text-[11px] text-muted-foreground hover:text-amber-600"
                                  >
                                    {isDisabled ? "启用" : "禁用"}
                                  </button>
                                )}
                              </>
                            )}
                            {m.role !== "owner" && (
                              <button
                                onClick={() => removeMember(m.subjectId)}
                                className="text-[11px] text-muted-foreground hover:text-destructive"
                              >
                                移除
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Agent onboarding card */}
                        {setupOpen && (
                          <div className="mt-2 rounded-md border border-violet-500/30 bg-violet-500/5 p-3">
                            {!agentSetup ? (
                              <div className="text-[11px] text-muted-foreground">
                                载入中…
                              </div>
                            ) : (
                              <>
                                <div className="mb-2 flex items-center justify-between">
                                  <div className="text-[11px] font-medium text-violet-700">
                                    把下面这段内容粘给你的 agent —— 它会自己连进来
                                  </div>
                                  <button
                                    onClick={copyInstructions}
                                    className="rounded bg-violet-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-violet-700"
                                  >
                                    {copied ? "已复制" : "复制"}
                                  </button>
                                </div>
                                <div className="mb-2 flex items-center gap-2">
                                  <span className="text-[10px] text-muted-foreground">
                                    目标文件:
                                  </span>
                                  <input
                                    value={agentSetupFileId}
                                    onChange={(e) => setAgentSetupFileId(e.target.value)}
                                    onBlur={() => {
                                      if (agentSetupFileId.trim()) {
                                        toggleAgentSetup(m.subjectId, agentSetupFileId.trim());
                                      }
                                    }}
                                    placeholder={agentSetup.fileId}
                                    className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none"
                                  />
                                </div>
                                <pre className="max-h-64 overflow-auto rounded bg-background p-2 font-mono text-[10px] leading-relaxed text-foreground">
                                  {agentSetup.instructions}
                                </pre>
                                <details className="mt-2">
                                  <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                                    环境变量（供 agent host 使用）
                                  </summary>
                                  <pre className="mt-1 overflow-auto rounded bg-background p-2 font-mono text-[10px] text-foreground">
                                    {agentSetup.envBlock}
                                  </pre>
                                </details>
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {/* Member picker — contacts from CatsCo friends/bots */}
                <div className="border-t border-border/40 pt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-[11px] font-medium text-muted-foreground">
                      添加成员
                    </div>
                    <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5">
                      <button
                        onClick={() => setAddMemberMode("picker")}
                        className={cn(
                          "rounded px-2 py-0.5 text-[10px] font-medium",
                          addMemberMode === "picker"
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground"
                        )}
                      >
                        好友/Bot
                      </button>
                      <button
                        onClick={() => setAddMemberMode("manual")}
                        className={cn(
                          "rounded px-2 py-0.5 text-[10px] font-medium",
                          addMemberMode === "manual"
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground"
                        )}
                      >
                        手动输入
                      </button>
                    </div>
                  </div>

                  {addMemberMode === "picker" ? (
                    <div className="space-y-2">
                      {contactsLoading ? (
                        <div className="text-[11px] text-muted-foreground">
                          载入联系人…
                        </div>
                      ) : contacts.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border/60 p-3 text-[11px] text-muted-foreground">
                          CatsCo 还没给你任何好友或 bot —— 先到 CatsCo 加好友
                          或创建 bot，再回来选。
                        </div>
                      ) : (
                        <div className="max-h-56 overflow-auto rounded-md border border-border/60">
                          {contacts
                            .filter((c) => !members.some((m) => m.subjectId === c.subjectId))
                            .map((c) => (
                              <button
                                key={c.subjectId}
                                onClick={() => addMember(c.subjectId, c.kind === "agent" ? "editor" : "editor")}
                                className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-accent/50"
                              >
                                <div className="flex items-center gap-2">
                                  <span
                                    className={cn(
                                      "inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white",
                                      c.kind === "agent" ? "bg-violet-500" : "bg-primary"
                                    )}
                                  >
                                    {(c.displayName || c.username).slice(0, 1).toUpperCase()}
                                  </span>
                                  <div>
                                    <div className="text-[12px] font-medium">
                                      {c.displayName}
                                      {c.kind === "agent" && (
                                        <span className="ml-1.5 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-600">
                                          agent
                                        </span>
                                      )}
                                    </div>
                                    <div className="font-mono text-[10px] text-muted-foreground">
                                      @{c.username} · {c.subjectId}
                                    </div>
                                  </div>
                                </div>
                                <span className="text-[11px] text-muted-foreground">
                                  + 加为 editor
                                </span>
                              </button>
                            ))}
                          {contacts.every((c) =>
                            members.some((m) => m.subjectId === c.subjectId)
                          ) && (
                            <div className="p-3 text-[11px] text-muted-foreground">
                              所有联系人已在项目里
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        value={newMemberId}
                        onChange={(e) => setNewMemberId(e.target.value)}
                        placeholder="u123 或 a456"
                        className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:ring-1 focus:ring-primary"
                      />
                      <select
                        value={newMemberRole}
                        onChange={(e) => setNewMemberRole(e.target.value as "viewer" | "editor")}
                        className="rounded-md border border-border bg-background px-2 py-1.5 text-[12px] outline-none"
                      >
                        <option value="editor">editor</option>
                        <option value="viewer">viewer</option>
                      </select>
                      <button
                        onClick={() => addMember()}
                        disabled={!newMemberId.trim()}
                        className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
                      >
                        添加
                      </button>
                    </div>
                  )}
                </div>
                <div className="mt-2 text-[10px] leading-relaxed text-muted-foreground/80">
                  添加 <code className="font-mono">a*</code> subject 后会自动展开接入指南 —— 复制给 agent 即可。
                </div>
              </div>
            )}

            {/* New doc form */}
            {showNewDoc && (
              <div className="border-b border-border/60 bg-accent/30 p-4">
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={newFileId}
                    onChange={(e) => setNewFileId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createDocument();
                      if (e.key === "Escape") setShowNewDoc(false);
                    }}
                    placeholder="文件路径 (如 notes/intro.md)"
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="标题（可选）"
                    className="w-48 rounded-md border border-border bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    onClick={createDocument}
                    disabled={busyActions.has("create-doc") || !newFileId.trim()}
                    className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {busyActions.has("create-doc") ? "创建中…" : "创建"}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[12px] text-destructive">
                {error}
              </div>
            )}

            {loadingDocs ? (
              <div className="p-4 text-[12px] text-muted-foreground">载入中…</div>
            ) : documents.length === 0 ? (
              <div className="flex flex-col items-center p-8 text-center">
                <div className="text-[13px] text-muted-foreground">
                  还没有文档，点击上方「+ 新建文档」
                </div>
                <button
                  onClick={() => setShowNewDoc(true)}
                  className="mt-3 rounded-md bg-primary px-4 py-1.5 text-[12px] font-medium text-primary-foreground"
                >
                  新建文档
                </button>
              </div>
            ) : (
              <FileTree
                documents={documents}
                onSelect={openDoc}
                onRename={startRename}
                onDelete={(doc) => setConfirmDeleteDoc(doc.id)}
                onNewInFolder={newDocInFolder}
                onRenameFolder={renameFolder}
                onDeleteFolder={deleteFolder}
                renamingDocId={renamingDoc}
                confirmDeleteDocId={confirmDeleteDoc}
                renderFileDetail={(doc) => (
                  <>
                    {renamingDoc === doc.id && (
                      <div className="border-t border-border/60 bg-accent/30 px-4 py-3">
                        <div className="space-y-2">
                          <input
                            value={renameTitle}
                            onChange={(e) => setRenameTitle(e.target.value)}
                            placeholder="标题"
                            className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-primary"
                          />
                          <input
                            value={renameFileId}
                            onChange={(e) => setRenameFileId(e.target.value)}
                            placeholder="fileId"
                            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] outline-none focus:ring-1 focus:ring-primary"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => setRenamingDoc(null)}
                              className="text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              取消
                            </button>
                            <button
                              onClick={saveRename}
                              className="rounded bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground"
                            >
                              保存
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    {confirmDeleteDoc === doc.id && (
                      <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-2">
                        <div className="flex items-center justify-between">
                          <div className="text-[11px] text-destructive">
                            确认删除「{doc.title || doc.fileId}」？
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => setConfirmDeleteDoc(null)}
                              className="text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              取消
                            </button>
                            <button
                              onClick={() => deleteDocument(doc)}
                              className="rounded bg-destructive px-2 py-0.5 text-[11px] font-medium text-destructive-foreground"
                            >
                              确认
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
