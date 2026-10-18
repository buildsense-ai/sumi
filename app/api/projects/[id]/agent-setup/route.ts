/**
 * Agent onboarding — return a copy-pasteable setup guide for the user to
 * give their agent (either a system prompt, a CLI command, or env vars).
 *
 * In Sumi, agents are just subjects (`a{uid}`) with a project_membership.
 * Their credential is a CatsCo ApiKey (`cc_*`) which the user (or their
 * agent host) already possesses — we never see it.
 *
 * The guide tells the agent:
 *   - what WS URL to connect to
 *   - which projectId/fileId to use
 *   - how to authenticate (api_key query param)
 *   - a minimal connectSumi() snippet
 *
 * GET /api/projects/:id/agent-setup?subjectId=a42[&fileId=...]
 */

import { getDb } from "@/src/db";
import { getProject } from "@/src/auth/identity";
import { actorForProject } from "@/lib/http-auth";
import { apiPath } from "@/lib/api-path";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const actor = await actorForProject(request, projectId);
  if (!actor) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const db = await getDb();
  const project = getProject(db, projectId);
  if (!project) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const subjectId = url.searchParams.get("subjectId");
  if (!subjectId || !subjectId.startsWith("a")) {
    return Response.json(
      { error: "subjectId must be an agent subject (a*)" },
      { status: 400 }
    );
  }

  // Member must exist
  const member = db
    .prepare(
      "SELECT role FROM project_members WHERE project_id = ? AND subject_id = ?"
    )
    .get(projectId, subjectId) as { role: string } | undefined;
  if (!member) {
    return Response.json(
      { error: "agent is not a member of this project" },
      { status: 404 }
    );
  }

  const fileId =
    url.searchParams.get("fileId") || "notes/intro.md";

  // Addresses handed to an agent that may not be running on this host.
  //
  // These defaulted to `http://localhost:3000` and `ws://localhost:12345`, which
  // is wrong twice over behind the artifact gateway: the app is served at
  // /<app-id>/ on a public origin, and the WS server listens on its own port
  // (1234 here, not the upstream default 12345). An agent following the guide
  // verbatim therefore could not connect at all.
  //
  // Note the variable names: `NEXT_PUBLIC_*` are inlined at build time, so
  // exporting one in the service environment after the build does nothing — the
  // deployment built without it, and the guide kept advertising localhost. The
  // `SUMI_PUBLIC_*` names below are plain runtime variables, read per request, so
  // they can be set (and corrected) without a rebuild. The public ones remain as
  // a fallback for upstream deployments that already set them.
  const publicOrigin = (
    process.env.SUMI_PUBLIC_ORIGIN ||
    process.env.NEXT_PUBLIC_SUMI_URL ||
    new URL(request.url).origin
  ).replace(/\/+$/, "");

  const wsBaseUrl =
    process.env.SUMI_PUBLIC_WS_URL ||
    process.env.NEXT_PUBLIC_WS_URL ||
    `ws://localhost:${process.env.WS_PORT || 12345}`;

  // Origin + the deployment's own base path. Keeping them separate is what stops
  // the guide from dropping /<app-id>/ — the prefix the gateway strips.
  //
  // The trailing slash is stripped because these values are pasted straight into
  // `SUMI_BASE_URL=…` and then joined with paths that begin with "/": leaving it
  // on produced "…/sumi//api/page-state/…" in the guide and a base URL whose
  // concatenation depends on the client normalizing double slashes.
  const appBaseUrl = `${publicOrigin}${apiPath("")}`.replace(/\/+$/, "");

  // The app's own page-state route, not the WS admin surface. The WS endpoint is
  // only reachable when that port is routed, which behind the gateway it is not;
  // the app route proxies to it and keeps the /<app-id>/ prefix.
  const pageStateUrl = `${appBaseUrl}/api/page-state/${projectId}`;

  const roomName = `${projectId}-${fileId}`;
  const wsUrl = `${wsBaseUrl}/${roomName}?api_key=cc_...`;

  const envBlock = [
    `SUMI_BASE_URL=${appBaseUrl}`,
    `SUMI_WS_URL=${wsBaseUrl}`,
    `SUMI_API_KEY=cc_...    # CatsCo ApiKey（换成 agent 自己的）`,
  ].join("\n");

  // This block is meant to be pasted as the agent's system prompt.
  const instructions = [
    `# Sumi 协作 — agent 接入指南`,
    ``,
    `你是「${project.name}」项目的协作者（subject_id: ${subjectId}）。Sumi 是一个多人`,
    `实时协作的 markdown 编辑器 —— 你和其他用户、agent 通过 Yjs CRDT 同时编辑同一篇文档。`,
    ``,
    `## 身份`,
    ``,
    `- subject_id:   ${subjectId}`,
    `- 角色:         ${member.role}`,
    `- 项目:         ${project.name} (${projectId})`,
    `- 目标文件:     ${fileId}`,
    ``,
    `## 最快接入 — sumi CLI（推荐）`,
    ``,
    `如果你的宿主已装了 sumi-kit（Pi/Claude/Codex 等都可以用 install.py 一键装），直接用 CLI：`,
    ``,
    `\`\`\`bash`,
    `export SUMI_BASE_URL="${appBaseUrl}"`,
    `export SUMI_API_KEY="cc_..."   # 你的 CatsCo ApiKey`,
    ``,
    `sumi whoami                          # 验证连接`,
    `sumi read-doc --project ${projectId} --file ${fileId} --raw`,
    `sumi propose-edit --project ${projectId} --file ${fileId} \\`,
    `  --blocks '[{"startLine":3,"endLine":5,"updated":"新内容"}]'`,
    `sumi pending-status --project ${projectId}`,
    `\`\`\``,
    ``,
    `加载 skill：sumi-bootstrap（首次验证）· sumi-collab（编辑/提案）· sumi-onboard（获取本文档）`,
    ``,
    `## 手动接入 — HTTP + WS`,
    ``,
    `没有 sumi-kit 就手写：`,
    ``,
    `\`\`\`bash`,
    `export SUMI_WS_URL="${wsBaseUrl}"`,
    `export SUMI_HTTP_URL="${appBaseUrl}"`,
    `export CATSCO_API_KEY="cc_..."`,
    `\`\`\``,
    ``,
    `\`\`\`ts`,
    `import { connectSumi } from "sumi/agent-client";`,
    ``,
    `const conn = await connectSumi({`,
    `  wsUrl: process.env.SUMI_WS_URL!,`,
    `  apiKey: process.env.CATSCO_API_KEY!,`,
    `  projectId: "${projectId}",`,
    `  fileId: "${fileId}",`,
    `  displayName: "${subjectId}",     // 你的光标颜色 + 显示名`,
    `});`,
    ``,
    `conn.ytext.insert(0, "# 大家好\\n");`,
    `conn.close();`,
    `\`\`\``,
    ``,
    `## 编辑文档（三种姿势，按场景选）`,
    ``,
    `### 1. 实时小改动 — 直接写 Yjs`,
    ``,
    `**首选 —— 让 Sumi 主机跑 co-edit daemon**（litewrite 模式）:`,
    ``,
    `\`\`\`bash`,
    `# 在 Sumi 主机上起一个 daemon，把 ${projectId} 的 docs sync 到一个目录`,
    `cd sumi && pnpm co-edit-daemon --dir /tmp/sumi-workspace --project ${projectId} \\`,
    `  --ws ${wsBaseUrl} --api-key cc_xxx`,
    ``,
    `# 然后 agent 直接读写本地文件：`,
    `echo "# 新内容" >> /tmp/sumi-workspace/${fileId}`,
    `# → daemon 自动 push pending-edit，人类看到 diff`,
    `\`\`\``,
    ``,
    `**或者跑你自己的 \`sumi co-edit\`**（轮询，不是 daemon）:`,
    ``,
    `\`\`\`bash`,
    `sumi co-edit --project ${projectId} --file ${fileId} --local /tmp/work.md`,
    `# 在另一个 shell：`,
    `echo "# 新内容" >> /tmp/work.md`,
    `# → 自动 POST /api/pending-edits，人类看到 pending diff`,
    `\`\`\``,
    ``,
    `**或者手动连 Yjs**（低延迟、真 CRDT、需要 JS runtime）:`,
    ``,
    `\`\`\`ts`,
    `conn.ytext.insert(pos, text);          // 在 pos 处插入`,
    `conn.ytext.delete(pos, len);           // 删除 pos..pos+len`,
    `conn.ytext.insert(pos, newText);       // 替换 = delete + insert`,
    `const content = conn.ytext.toString(); // 当前全文`,
    `\`\`\``,
    ``,
    `**注意**：别用大段 delete+insert 覆盖 —— 优先小颗粒度的编辑，避免`,
    `弄乱别人的光标位置和合并冲突。`,
    ``,
    `### 2. 让人类审阅 — POST /api/pending-edits`,
    ``,
    `对结构性改动（删大段、重写整节），**永远先走 pending-edit**，让人类点「保留/撤销」：`,
    ``,
    `\`\`\`bash`,
    `curl -X POST "${appBaseUrl}/api/pending-edits" \\`,
    `  -H "Authorization: Bearer $CATSCO_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "projectId": "${projectId}",`,
    `    "fileId": "${fileId}",`,
    `    "blocks": [`,
    `      { "startLine": 5, "endLine": 8, "updated": "新的 5-8 行内容" }`,
    `    ],`,
    `    "description": "为什么这样改 — 给人类看的理由"`,
    `  }'`,
    `\`\`\``,
    ``,
    `- \`startLine/endLine\` 是 1-based 含端点`,
    `- Sumi 会自动给每个 block 加 RelPos 锚点 —— 即使文档漂移也能找准`,
    `- 用户点「保留」后，改动落到 Yjs 广播`,
    `- 用户点「撤销」则什么都不发生`,
    ``,
    `### 3. 全量重写 — PUT /api/documents/content`,
    ``,
    `整篇覆盖时先 GET 拿 \`contentHash\`，然后带 \`baseContentHash\` PUT。`,
    `撞 409 FILE_CONFLICT 就重新 GET 再试，或者加 \`force: true\`。`,
    ``,
    `## 其它 API`,
    ``,
    `| 用途 | 调用 |`,
    `|---|---|`,
    `| 验证身份 | \`GET /api/auth/me\` |`,
    `| 列出项目文档 | \`GET /api/projects/${projectId}/documents\` |`,
    `| 项目成员 | \`GET /api/projects/${projectId}/members\` |`,
    `| 新建文档 | \`POST /api/projects/${projectId}/documents { fileId, title }\` |`,
    `| 上传图片 | \`POST /api/projects/${projectId}/assets\` (binary body, \`x-file-name\` header) |`,
    `| 文档元数据 | \`GET /api/documents/content?projectId&filePath\` → \`{ content, contentHash }\` |`,
    `| 页面状态 | \`GET ${pageStateUrl}\` — 谁在看什么文档、哪个面板开着 |`,
    ``,
    `## 富文本回答 — json-render Spec`,
    ``,
    `当你 answer-intent 时，如果 \`answerText\` 是一个合法的 json-render Spec，Sumi 会把它渲染成 UI 组件（shadcn/ui），而不是纯文本。`,
    ``,
    `### Spec 格式`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "root": "card1",`,
    `  "elements": {`,
    `    "card1": { "type": "Card", "props": { "title": "分析结果" }, "children": ["t1", "doc1", "btn1"] },`,
    `    "t1":    { "type": "Text", "props": { "text": "发现了 3 个待处理 edits" } },`,
    `    "doc1":  { "type": "DocumentCard", "props": { "title": "intro.md", "filePath": "docs/intro.md" } },`,
    `    "btn1":  { "type": "Button", "props": { "label": "打开", "action": "open_document" } }`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `### 可用组件（json-render shadcn catalog）`,
    ``,
    `| 类别 | 组件 |`,
    `|---|---|`,
    `| 布局 | Card · Stack · Grid · Separator · Tabs · Accordion · Collapsible |`,
    `| 内容 | Heading · Text · Image · Avatar · Badge · Alert · Table |`,
    `| 反馈 | Progress · Skeleton · Spinner · Tooltip · Popover |`,
    `| 表单 | Input · Textarea · Select · Checkbox · RadioGroup · Switch · Slider · DatePicker |`,
    `| 动作 | Button · ButtonGroup · Pagination |`,
    `| 容器 | Dialog · Drawer · Carousel |`,
    `| Sumi | DocumentCard — 项目文档卡片，自带「打开」按钮 |`,
    ``,
    `### 可用 actions`,
    ``,
    `- \`open_document\` — { documentId } — 在编辑器里打开文档`,
    `- \`apply_pending_edit\` — { editId } — 应用一个 pending edit`,
    `- \`copy_to_clipboard\` — { text } — 复制文本`,
    `- \`open_url\` — { url } — 新 tab 打开外部链接`,
    ``,
    `### 什么时候用`,
    ``,
    `- ✅ 展示分析结果/报告 — 用 Card + Text + Progress + Stat`,
    `- ✅ 列出文档 — 用 DocumentCard 列表`,
    `- ✅ 交互式操作 — 用 Button 触发 action`,
    `- ❌ 简单一句话回答 — 直接纯文本`,
    ``,
    `如果 spec 渲染失败，Sumi 会降级为纯文本展示，不会 crash。`,
    ``,
    `## 约束`,
    ``,
    `- 当前角色是 \`${member.role}\`${
      member.role === "viewer"
        ? " —— **写入会被服务端丢弃**，你只能读"
        : " —— 可以写入"
    }`,
    `- 修改通过 Yjs 广播给所有在线协作者，包括浏览器里的人`,
    `- 编辑结束后调用 \`conn.close()\`，别占着连接`,
    `- 任何写操作失败都返回 JSON \`{ error }\`，不要静默吞错`,
    `- **结构性改动永远走 pending-edit** —— 不要静默 PUT 覆盖别人写的`,
  ].join("\n");

  return Response.json({
    projectId,
    projectName: project.name,
    subjectId,
    role: member.role,
    fileId,
    roomName,
    wsBaseUrl,
    wsUrl,
    envBlock,
    instructions,
  });
}
