# LLM for Zotero Papers：UI/UX 重设计与多代理 Hill Climbing 记录

> 目标分支：`codex/ui-hill-climb`   
> 基线分支：`codex/papers`  
> 仓库：<https://github.com/Molaison/llm-for-zotero-papers>

## 交付范围

本提交包含：

- 可运行的 Zotero XUL/XHTML UI 重设计代码。
- 保留原有事件处理器、DOM ID、状态属性和数据属性的兼容性补丁。
- `.ui-baseline/` 中的初始代码快照，便于恢复和逐文件比较。
- `ui-preview/` 中的结构化 Before/After 预览 HTML、样式和渲染脚本。
- `artifacts/` 中按固定视口生成的四轮 A/B 预览，以及 Preferences 和 Standalone 终态预览。
- 本文档中的 IA、交互、视觉规范、审查结论、回退记录和未解决风险。

## 授权与分支

已确认 GitHub 连接使用者为 `Molaison`，对目标仓库拥有 push/maintain/admin 权限。已在远程创建工作分支 `codex/ui-hill-climb`，所有后续变更均写入该分支；完成后通过 Pull Request 合并到 `codex/papers`。

## Phase 1：三代理研究结论

### 设计参考

1. [Zotero PDF Reader](https://www.zotero.org/support/pdf_reader) 及 [PDF Reader quick start](https://www.zotero.org/support/pdf_reader/quick_start_guide)：证据上下文、批注与原文位置之间的可追溯关系。借鉴点是让当前 paper/note scope 始终可见，引用卡片保持原文锚点。
2. [Paperpile user interface](https://paperpile.com/h/user-interface-explained/)、[library navigation](https://paperpile.com/h/view-navigate-library/) 和 [PDF navigation](https://paperpile.com/h/view-navigate-pdfs/)：固定导航、中央工作区、右侧详情和批量/多选模式。借鉴点是将低频设置从主路径移入 disclosure，同时保留工作区的三段层级。
3. [Readwise Reader docs](https://docs.readwise.io/reader/docs) 和 [navigation FAQ](https://docs.readwise.io/reader/docs/faqs/navigation)：键盘优先、命令式入口、可收起的侧栏和 highlights/notes 的快速回看。借鉴点是保持历史和低频操作可发现，但不让它们抢占 composer。
4. [Elicit systematic review](https://elicit.com/solutions/systematic-review) 及 [getting started](https://support.elicit.com/en/articles/14757543-getting-started-with-elicit)：明确的阶段路径、证据审计和任务状态。借鉴点是把 run status、task progress 和 citation evidence 视为一组可观察对象。

综合决策是：采用 **Zotero 的证据上下文 + Paperpile 的稳定工作区层级 + Readwise 的渐进披露/键盘效率 + Elicit 的可审计状态**，不复制任何单一产品的视觉外观。

### IA 审查

当前真实主流程是：选择 paper/PDF → 进入 Paper/Library chat → 添加上下文 → 选择 runtime/model → 发送 → 查看回答、引用和任务进度 → 保存、导出、恢复或新建会话。

结构性问题：

- Paper、Library、Note、WebChat、stacked/independent、standalone 以及 Codex/Claude/WebChat 等维度被分散在多个标题、按钮和面板中。
- 当前 paper 身份、library scope 和 note scope 没有一个稳定的视觉锚点。
- context source、runtime 和 upload 入口被分散，用户需要在不同区域寻找“这次运行到底带了什么”。
- history 主要依赖时钟图标，发现成本高；状态文字与任务状态不在同一视觉层级。
- Preferences 以实现/技术名称组织，而不是以用户要完成的配置任务组织。

目标 IA：

```text
Scope bar → Conversation timeline → Composer
                         ├─ This paper / note
                         ├─ Across library
                         ├─ Add context
                         └─ runtime / model

Composer footer → run status → task progress → citations / evidence
Preferences → Connections | Chat experience | Agent & permissions | PDF & context | Usage & diagnostics
```

### 代码审查

当前实现是 Zotero XUL/XHTML + TypeScript DOM builder，不是 React。关键约束是：

- `src/modules/contextPanel/buildUI.ts` 创建聊天面板并由大量已有 handler 通过稳定 ID 查找节点。
- `addon/content/zoteroPane.css` 是共享视觉入口，采用 append-only override，避免覆盖原实现造成难以回滚的冲突。
- `preferences.xhtml`、`preferenceScript.ts` 共享 `data-pref-tab`/`data-pref-panel` 契约。
- standalone sidebar 和 layout 逻辑由 `standaloneSidebarView.ts`、`sidebarLayout.ts` 管理，应增加可访问性与状态标识，但不改变业务事件。
- PR #8 的 library drop、PR #9 的 PDF upload/ownership/terminal state、历史恢复链路都要求保留现有 IDs/data attributes。

## Phase 2：实现边界与文件所有权

| 代理 | 所有文件 | 交付 |
|---|---|---|
| Agent 1 | `addon/content/zoteroPane.css` | Design Tokens、响应式布局、scope/context/status/task/citation 视觉系统 |
| Agent 2 | `src/modules/contextPanel/buildUI.ts` | scope bar、context tray、runtime 位置、history 语义、run status wrapper |
| Agent 3 | `addon/content/preferences.xhtml`、`src/modules/preferenceScript.ts`、`src/modules/contextPanel/standaloneSidebarView.ts`、`src/modules/contextPanel/sidebarLayout.ts` | Preferences IA、ARIA tab 交互、standalone history label、layout state metadata |
| 主代理 | `docs/`、`.ui-baseline/`、`ui-preview/`、`artifacts/`、整合 | 统一规范、冲突修复、A/B 记录、发布与 PR |

所有代理均按文件边界实施；共享规范由主代理统一为本文件和 CSS 末尾的 `UI REDESIGN HILL CLIMB` 区段。

## IA、核心交互和视觉规范的变化

### Scope bar

`buildUI.ts` 现在在 header 下方创建 `#llm-scope-bar`，通过 `data-scope` 明确 `paper`、`library`、`note` 和 `empty`，并展示 title、first creator、year。该层只负责呈现，保留原有 ID 和 handler 契约。

### Composer context tray

runtime toggle 和 upload slot 从拥挤的 header overflow 移入 `#llm-context-previews`。上传按钮在常规宽度显示 `Add context`，在 420px 以下保留可访问名称并视觉收缩为 `+`。context preview 使用最大高度和内部滚动，避免长引用把输入框推出视口。

### History 与低频操作

History 保留原 clock button 和原 ID，同时在足够宽度显示短文本标签；窄屏回退为 icon-only。settings、pop-out、restore、export、clear 等低频功能继续位于 native disclosure 中。

### Run status

`#llm-status` 仍由既有业务状态机控制，外层增加 `llm-run-status-strip`。最终 CSS 显式恢复状态文本的可见布局，并映射现有 `.llm-status-ready`、`.llm-status-sending`、`.llm-status-warning`、`.llm-status-error` 类；长状态在 strip 内 ellipsis，避免挤压发送控件。

### Preferences

将面向实现的 tab 名称改为面向任务的 Connections、Chat experience、Agent & permissions、PDF & context、Usage & diagnostics。新增真正的 ARIA tablist/tab/tabpanel 语义、roving tabindex、Arrow/Home/End/Enter/Space 操作和 hash deep link；不修改既有 `data-pref-*` 与业务配置 hook。

### 视觉系统

- 局部 token：7/10/12px radius、34px control height、raised/soft surface、border/focus/shadow。
- 对话区使用稳定的 header → scope → timeline → composer 层级。
- user bubble 右缩进，assistant 输出保持阅读宽度；citation、task progress、source chips 使用统一的 raised surface 和 border。
- `prefers-reduced-motion`、`:focus-visible`、dark mode shadow 和 400/520px 断点均有明确处理。

## Phase 3–5：真实运行与 A/B Hill Climbing 记录

由于当前受限工作区没有 Zotero runtime、依赖目录或可绑定的 GUI 浏览器，无法诚实地声称已经取得 Zotero 运行时截图。`artifacts/*.png` 是用固定 1280px 视口的 PIL 结构化视觉 proxy，提供可重复的区域和间距对比；实际 Zotero 截图必须在安装依赖并启动 Zotero 后补采。代码级 A/B 仍按真实 DOM、handler 和 CSS 状态进行审查。

| 轮次 | A → B 核心改动 | A/B 结论 | 保留/回退 | 下一轮 |
|---|---|---|---|---|
| Round 1 | 增加 scope bar、context tray、composer/card 层级、citation/task 统一 | B 更利于回答“我正在和什么对话、上下文在哪里、下一步怎么发出”，且保留既有 handler | 保留 | 显示 Add context、修复窄屏 scope 排列、统一 shadow/status |
| Round 2 | Add context 可见、status strip、dark shadow token、420px 规则后置 | B 解决发现性和窄屏层叠问题；审查发现原 CSS 的 `::after` 会重复 Add context 文案 | 保留修复后的 B；移除重复 `::after`，移动 420px media block | History 文字提示、Preferences keep-all、status 溢出 |
| Round 3 | History 短标签、Preferences 任务文案、tablist 键盘语义、状态溢出 | B 更快暴露 history 和设置分组；scope 在窄宽度保持可读，未改变业务 ID | 保留 | 验证 status 真正可见、核对真实 state class |
| Round 4 | status 文本从旧的 visually-hidden 规则中恢复；使用真实状态 class 映射；最终 ellipsis | B 消除了一个功能性回退：此前 status wrapper 存在但 status 文本仍被原规则裁成 1px。B 保持低频区域不挤压 composer | 保留；不再继续微调，等待 Zotero runtime 验证 | 在真实 Zotero 中执行 Paper→Library→Paper、history、PDF upload/cancel/retry、400px 检查 |

每轮的 proxy 文件：

- [Round 1 Before](../artifacts/round1-before.png) / [Round 1 After](../artifacts/round1-after.png)
- [Round 2 Before](../artifacts/round2-before.png) / [Round 2 After](../artifacts/round2-after.png)
- [Round 3 Before](../artifacts/round3-before.png) / [Round 3 After](../artifacts/round3-after.png)
- [Round 4 Before](../artifacts/round4-before.png) / [Round 4 After](../artifacts/round4-after.png)
- [Round 5 Before](../artifacts/round5-before.png) / [Round 5 After](../artifacts/round5-after.png)
- [Round 6 Before](../artifacts/round6-before.png) / [Round 6 After](../artifacts/round6-after.png)
- [Final Preferences](../artifacts/final-preferences.png) / [Final Standalone](../artifacts/final-standalone.png)

这些文件命名、视口和渲染条件固定，便于后续用真实 Zotero 截图替换；不能把它们当作 Zotero runtime screenshot。

### Round 5：空闲状态与上下文分组

Round 5 的 A 是 Round 4 的 B。IA 和代码审查都发现：有 paper 但尚未运行时，空的 status strip 仍占据 composer 的横向和纵向空间；同时 Agent mode、已有 context chip、上传入口和文件预览直接混在一条 flex 流中。B 在 `buildUI.ts` 中为 status line 增加兼容 Gecko 的 `MutationObserver`，以 `llm-run-status-empty` 控制 idle 折叠；为 context tray 的现有节点增加 `data-context-group`，并加入 presentation-only 的 Current context / Add context 标签。没有移动任何原有节点，也没有引入 `:has()`。

Round 5 的 B 更有利于实际任务：idle 时发送和模型控件得到完整宽度，运行中/错误/完成状态出现时仍可见；用户能先区分当前 scope，再识别要添加的上下文。B 没有改变 upload、history、runtime 或 context handler 的 ID 和节点关系，也没有增加第三个空状态 CTA。保留本轮改动。下一轮应在真实 Zotero runtime 观察 ready → sending → error → complete，以及多文件 upload 的 queued/running/failed/retry 状态。

### Round 6：现有上下文控件的可访问名称

Round 6 的 A 是 Round 5 的 B。三代理审查检查了 Zotero、Paperpile 和 Readwise 的证据回跳、逐文件上传进度和快捷键模式，也检查了当前稀疏镜像中的 citation/upload DOM。当前镜像无法证明真实 citation handler 或逐文件 upload state 的实现位置，因此没有凭空增加新的 citation 数据模型、Show on Page handler 或 retry 状态机。

B 只给已有的 `#llm-image-preview-meta`、`#llm-remove-img`、`#llm-file-context-meta`、`#llm-file-context-clear` 控件补充清晰的 `aria-label`，分别说明展开截图、清除截图、展开文件和清除上传文件。视觉几何保持不变；这两张 Round 6 proxy 截图因此像素相同，但代码层面的 A/B 差异能直接改善屏幕阅读器用户的任务完成路径，且点击行为、ID 和 handler 均未改变。保留本轮改动。下一轮优先在真实 Zotero 中验证 citation 回跳和逐文件 queued/running/failed/retry 状态，再决定是否需要可见 secondary affordance。

## 已完成验证

- `buildUI.ts`、`preferenceScript.ts`、`standaloneSidebarView.ts`、`sidebarLayout.ts` 的括号/花括号计数平衡。
- `preferences.xhtml` 和 `standaloneChat.xhtml` 可被 XML parser 解析。
- 原始关键 ID、data attributes 和 handler 查询路径保留；改动只添加呈现层和无副作用状态 metadata。
- CSS 使用 append-only redesign section，且 420px narrow rule 位于 520px rule 之后。
- 对原始 CSS 的 visually-hidden status 规则进行了实际审查，最终覆盖为可见、可 ellipsis 的 status strip。

当前没有声称完成 TypeScript build/typecheck：工作区没有 `node_modules`，且不能通过网络安装依赖。

## 尚未解决的重要问题

1. 需要在可运行的 Zotero 环境中重新生成所有主要页面和状态的真实截图，并记录浏览器/窗口尺寸。
2. 需要真实验证 Paper → Library → Paper 切换时 scope、history、runtime 和 context preview 是否保持正确。
3. 需要验证 PR #8 library drop 的持久化、PR #9 PDF upload 的 ownership/terminal/cancel/retry 状态，以及 error/empty/loading 文案。
4. 需要在 400px 和深色主题下检查 native XUL 控件的字体、颜色和 focus ring；当前 CSS 已提供回退规则，但尚未有 runtime 证据。
5. 安装项目依赖后执行仓库既有 lint/typecheck/build；本轮没有把测试数量扩大到与功能风险无关的程度。

## 恢复与继续工作

恢复时从 `codex/ui-hill-climb` 分支开始：先查看 `.ui-baseline/` 与当前文件的差异，再运行 `ui-preview/render_proxy.py` 生成结构化预览，最后在 Zotero runtime 中补真实截图。主入口修改点是 `buildUI.ts` 与 CSS 末尾 redesign section；Preferences 和 standalone 的行为契约见 Phase 2 表。
