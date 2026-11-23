# Windows 项目式多设备协作

本分支在 Durable Pi 上增加了 Windows 原生运行方式和项目隔离层。它不是让一个 Pi CLI 窗口同时读取三台电脑，而是让每台电脑运行自己的持久 Agent，再由中心 Hub 按项目连接它们。

```text
中心电脑 A（Hub + Agent）
  项目 1 ─ A/Main ─ B/资料 Agent ─ C/执行 Agent
  项目 2 ─ A/Main ─ B/另一个 Agent ─ C/另一个 Agent

每个成员地址 = 项目 + 设备 + 会话 + Agent
```

项目 1 无法用成员 ID 向项目 2 发消息。电脑上的文件仍留在原电脑，Agent 只返回任务结果，不会自动同步整块磁盘。

完整回归入口为 `windows/verify-platform.ps1`。默认执行三套 TypeScript 检查/测试、前端构建、确定性 SBOM 和生产依赖漏洞门；`-Live` 追加本机 Backend/Hub 与项目数据库完整性检查，`-Extended` 再执行隔离 Scheduler 压力测试，和 `-Live` 一起使用时还会在临时目录完成一次真实备份恢复演练。所有可重建临时文件固定放在工作区的 `临时文件` 子目录并在成功或失败后安全清理。

```powershell
.\windows\verify-platform.ps1 -Live
.\windows\verify-platform.ps1 -Live -Extended
```

每次任务派发都会先经过 Context Budget Manager：当前任务受到保护，项目记忆按安全/架构基础优先级与本次任务的中英文词项相关度装配，并为模型输出和后续工具结果保留空间。预算结果会显示在项目的 Activity & tool audit 中。

Codex 首次任务使用保守的 32K 上下文窗口；真实 `thread/tokenUsage/updated` 上报窗口后，后续任务使用最近 30 天同模型观测值的最小值，并受默认 128K 平台硬上限约束。输出至少预留窗口的 10%，工具结果至少预留 5%，且两者都不少于 4K。缺少观测时绝不根据模型名称猜测窗口；更新事件暂时缺少窗口字段时也不会擦除已有证据。审计事件记录预算来源、样本数、观测时间、平台上限、裁剪和排除项。可用 `DPI_FALLBACK_CONTEXT_TOKENS / DPI_MAX_CONTEXT_TOKENS / DPI_RESERVED_OUTPUT_TOKENS / DPI_RESERVED_TOOL_TOKENS` 调整平台边界。

Projects 的 Project memory 可选择 **Shared project memory** 或某个 Agent 的私有作用域。共享事实会注入该项目所有 Agent 的新任务；私有事实只注入指定 Agent，其他 Agent 的查询和任务上下文都不可见。交接包只导出共享事实，不携带 Agent 私有记忆。

长期事实可设置绝对 `expiresAt`。Hub 启动时及运行期间默认每分钟把到期 ACTIVE 事实事务性转为 EXPIRED，同时保存新版本和审计事件；读取与上下文装配也会即时执行到期检查，因此旧环境状态不会在定时器间隔内继续进入模型。`DPI_MEMORY_EXPIRY_INTERVAL_MS` 可在 10 秒至 24 小时范围内调整。T3 的 `remember_durable_fact` 使用 `expires_at`；相同请求重放会校验期限，不能复用幂等键延长事实有效期。Handoff 保留尚未到期事实的绝对期限，导入时已经过期的事实会跳过而不会复活。

项目模板只有一份 SDK 级目录，Hub 创建项目和 T3 `initialize_durable_project` 共用同一组角色、权限与并发边界，避免两个入口随着升级产生不同计划。Blank 模板会冻结 Coordinator、Coder、Tester、Reviewer 的通用按需团队计划，但初始化时仍只创建 Coordinator；其余角色仅在真实任务需要时实例化。其他模板的建议角色同样会复制成项目自己的冻结计划，后续修改模板不会暗中改变正在工作的项目。Runtime 启动时会事务性升级空闲的旧 Blank 项目和 Codex 成员模型；存在未结束任务的项目会跳过，避免迁移与执行竞争。

日常使用不再要求用户发送初始化口令。T3 的 `Codex · Durable Coordinator` 使用独立的 `durable-pi-auto` MCP 实例；未纳管目录第一次装载 Tool List 时，它会以目录名生成确定性项目身份，按根目录标识推断模板，采用 `SUPERVISED`，绑定全部已配置的只读 Windows/Linux/macOS 资料源，并只创建 Coordinator。用户在 T3 添加或打开目录后可直接描述真实任务；普通 Codex Provider 继续使用非自动的 `durable-pi`，不会因为查看任意目录而擅自登记项目。

T3 中“项目”和“会话”是两层对象：同一个目录只登记为一个项目，所以再次添加相同目录会返回已有项目，这是数据去重而不是会话被锁死。需要并行讨论时应在该项目内点击 **New thread / 新会话**；每条顶层会话保持独立历史，Coordinator 派生的 Worker 会话显示在该顶层会话的关联会话区域。重新添加目录不是新建会话的入口。

Windows 的日常入口固定为 T3 Code 桌面版。桌面版内置 Server 与 `t3 service install` 会争用默认的 `%USERPROFILE%\.t3`，因此默认 Home 不安装后台 T3 服务；桌面版直接读取现有项目、Provider、Thread 与远程 Environment。若以后确需无界面 T3 服务，必须分配独立 `T3CODE_HOME`，不能与桌面版共用默认 Home。

T3 的 `durable-pi` 与只读 `durable-data` MCP 进程可能比一次 Hub 修改活得更久，因此它们不会缓存授权快照。每次 Tool List/Call 都会从 SQLite 重新确认当前项目成员、角色和项目策略；成员被移除或 Coordinator 被降权后，既有进程下一次调用立即失败关闭，不会继续使用启动时的旧身份。资料源绑定本身也在每次调用时从目录重读。

首次初始化按“项目投影 → 资料源授权 → Coordinator 身份 → 完成事件”的顺序执行，但只有最后一步成功才视为完成。资料源或成员创建失败时会恢复此前绑定并删除本次新建的项目；进程在 Coordinator 创建后中断时，相同初始化重放会根据 `project.initialized_from_t3` 补写唯一完成事件。失败不会把工作目录卡在“已经受管但无法继续 Onboarding”的半初始化状态。
Tool List 也按当前角色最小化：普通成员只看到项目摘要、Agent 发现、自身 Task、可见 Memory/Artifact 和私有记忆写入；远程执行、交接、调度与生命周期工具只向 Coordinator 发布。初始化完成后，数据源候选和初始化工具从列表消失，已知名称直接调用数据源候选也会拒绝，不能借长生命周期 Provider 查看其他项目尚未绑定的来源标签。

`durable-data` 对本机和 SSH 两条读取路径执行同一套敏感目录策略。除 `.ssh`、云 CLI、`.env*` 和私钥格式外，`.dpi`、`.codex`、`.t3`、Pi/Claude/Gemini/Grok 等 Agent 运行目录、浏览器配置、包管理器凭证/缓存、Shell/数据库历史和 Git 凭证均不会出现在列举、搜索、正文读取或 Artifact 暂存中；远端返回的文件名与正文仍统一标记为 `UNTRUSTED_DATA`。

`list_durable_agents` 同时返回每个 Agent 的实时 `workState`（`IDLE / QUEUED / BUSY / WAITING`）、精确未完成任务数、按状态计数和最多 20 条有界调度摘要。任务正文、输入、结果和私有上下文不会混入负载摘要；Coordinator 可据此选择空闲成员，而最终并发与共享工作区互斥仍由 Scheduler 强制执行。
Agent 发现结果只暴露协作所需的角色、权限、模型、工作区、目标 Environment 和生命周期；内部 Session/Agent/Thread ID、Provider 归属、工具版本及生成幂等键不会发给其他 Agent。
若临时 Agent 的 Scope Task 已终结但成员仍未归档（通常是工作树有未提交内容），发现结果会额外返回 `cleanupPending: true` 和 `scopeTaskStatus`，Coordinator 不会把它误判成可直接丢弃的普通空闲成员。

`list_durable_tasks` 也遵守 Agent 可见性：Coordinator 可查看项目级调度元数据，普通成员只能查看明确派发给自己的任务。两种视图都不返回原始 Task Input；结果和错误最多返回 4,000 字符，超限时只保留摘要、长度与 SHA-256，防止一个列表调用把其他 Agent 的上下文或大段输出灌入当前模型。

记忆列表同样有输出预算：单个 Value 最多 8,000 字符，整个结构化结果最多约 50,000 字符，超过后返回可追溯预览并明确 `truncatedBySize`。跨设备执行目标、Handoff、Relay、Return 及其本机目录/Ref 只允许 Coordinator 查询；普通 Worker 不能借只读列表获得交接控制面的内部信息。

Hub 的临时 Agent 管理入口与 T3 动态工具执行同一组不变量，不能作为绕过路径：只接受当前项目 Coordinator、要求稳定 `requestId`、同键改参数会拒绝、最多 8 个活动临时成员、权限不能超过模板、远程模板不能伪装成本机执行。可写本机模板默认自动创建幂等 Git Worktree；完成、取消、删除或归档时只清理该 Agent 确定性拥有且干净的工作树，脏工作树返回冲突并保留内容。
清理前先预检工作树，再归档 Thread；如果存在未提交内容，Agent 与 Thread 均保持活动，避免出现“文件保住了但会话先被归档”的半完成状态。Worker 自动收尾与 Hub 手动收尾都遵守这一顺序。
通用成员创建 API 明确拒绝 `temporary / parentMemberId / scopeTaskId / spawnRequestId / lifecycleState`，所有临时生命周期只能经过上述专用入口，不能通过构造原始 JSON 绕过上限、父级和清理规则。

项目 `maxActiveTasks` 不再只约束 Coordinator 动态工具。Hub 的直接任务创建与项目消息入口也在 `BEGIN IMMEDIATE` 领取同一写锁后检查活动任务数，达到上限时原子拒绝；取消或终结任务释放名额。平台内部的结果/失败通知仍使用受控系统路径，避免在项目正好满额时丢失必要回信。

项目消息的 `requestId` 是参数绑定的幂等键，不只是去重字符串。同一 ID 只有在目标、正文、类型、发送成员、Correlation、Payload、Busy 策略和超时完全一致时才返回原任务；任何变化返回 `409`。ID 限制为 1–240 字符，`whenBusy` 只允许 `followUp / steer / reject`，已认证的 `fromMemberId` 固化进不可变 Task Input，防止重放时更换发送者或悄悄改变任务。

Projects 中的 Artifacts 用于测试报告、研究文档和任务产物。正文保存在 `%USERPROFILE%\.dpi\artifacts\<project>`，不写入 SQLite；下载时会重新校验大小和 SHA-256。标记 “Include in future handoff package” 的产物可供后续交接包选择。

Artifacts 区域既可发布文本，也可使用 “Upload binary” 上传音频、模型、压缩包或构建文件。上传过程按块写盘并计算 SHA-256，默认单文件上限 100 MiB，不会把二进制正文塞入 JSON 或数据库；超过上限或连接中断会清理半成品。

带 `expiresAt` 的 Artifact 到期后由 Hub 自动从 ACTIVE 转为 EXPIRED，读取路径也会即时执行同一保护，避免定时器间隔内继续暴露过期内容；转换和审计事件在同一事务内且可安全重复。默认每分钟检查一次，可用 `DPI_ARTIFACT_EXPIRY_INTERVAL_MS` 在 10 秒至 24 小时范围内调整。过期后正文仍保留用于短期恢复；Platform backups 区域的 “Purge expired (30d)” 会清理超过 30 天的过期正文。清理前重新验证路径、大小和 SHA-256，并使用可回滚的 tombstone 流程，不会直接删除校验失败的文件。

文本 Artifact API 接受绝对毫秒时间 `expiresAt`，二进制上传使用 `x-artifact-expires-at`；Coordinator 的 `stage_data_artifact` 则可用更安全的 `retention_days`（1–3650）表达相对保留期。该值进入请求幂等校验，同一 `request_id` 不能在重放时偷偷改变保留策略。

删除项目属于不可逆管理操作。Hub 会先检查受管 Worktree 的脏状态，避免在注定失败的删除前归档 Agent Thread；随后确认没有活动任务，并创建一份包含项目数据库、ACTIVE Artifact 和仍处于保留期的 EXPIRED Artifact 的 `pre-delete` 一致性备份，备份失败则拒绝删除。备份完成后再次检查任务数，并在 SQLite 中取得项目删除 Fence；此后 Hub、Coordinator MCP 与后台 Worker 的新任务准入都会原子拒绝，不能在最终删除窗口内插入后被级联丢弃。Fence 同时冻结删除开始前的资料源 ID，平台撤销这些只读绑定后再清理受管工作树、Artifact 与 Handoff；中途失败会解除 Fence 并恢复原资料源绑定，进程崩溃后重试则从同一 Fence 和冻结清单继续。删除响应返回恢复备份的名称、路径、SHA-256 和已撤销资料源。资料源目录的写入另有跨进程锁和陈旧锁恢复，Hub 与多个 T3 Provider 同时改绑定时不会以最后写入者覆盖另一方结果。

Projects 中的 Handoff bundles 可生成版本化交接目录，位置为 `%USERPROFILE%\.dpi\handoffs\<project>\<handoff>`。其中包含项目元数据、成员、有效项目记忆和明确允许进入交接包的 Artifact，并对清单和每个产物保存 SHA-256。源码默认不包含在包内，应继续通过 Git 或受控目录复制；Token、运行数据库和未结束的 Agent Session 不会写入交接清单。可选填写 **Git repository root**：平台只接受仓库根目录和干净、已提交的 HEAD，并把仓库名、分支和完整 Commit 写入清单；未提交修改会阻止 Git-aware handoff，但清空该输入仍可创建原有的元数据交接包。每条记录可再次 Validate；路径逃逸、符号链接、身份/协议不匹配以及文件大小或哈希变化都会被拒绝。

在目标电脑导入时，把完整交接目录复制到 `%USERPROFILE%\.dpi\handoff-inbox` 的直接子目录，在 Projects 左栏填写该子目录名称并选择 “Verify and import”。平台验证整个包后才创建项目，且固定以 `Supervised` 模式导入，不继承源电脑成员、工作目录和自治权限。交接清单会保留角色、Executor、权限档位、主模型和显式备用模型等 Agent 蓝图，并在目标项目保存为 `system.handoff.agent_blueprints` 系统记忆；导入过程创建的活动 Agent 数固定为 0。随后可在 **Imported Agent blueprints** 中逐个重新绑定：目标权限必须明确选择并默认 `READ_ONLY`，Codex 重新验证当前登录的模型和备用模型，Pi 重新验证所选设备/Session/Agent，目标工作目录也必须重新填写或确认。重复提交使用稳定绑定标识，不会创建第二个 Agent，也不能扩大第一次绑定的权限；源临时 Agent 只供审计，不能恢复。`system.*` 记忆命名空间只允许平台内部写入，普通用户、Agent 和跨设备普通记忆无法伪造、修改或过期蓝图；管理界面将其标记为只读，而且 Agent 可见记忆与自动上下文会过滤所有 `system.*` 投影，避免把路径或交接元数据误当成模型指令。未绑定蓝图可继续进入下一跳交接包，系统投影本身不会被当成普通项目记忆重复导出。当前导出格式为 Schema 2；旧 Schema 1 清单会在校验后补入保守默认值再迁移，未知或未来 Schema 仍在创建项目之前拒绝。外部任意路径不能通过此入口读取。带 Git 基线的包会把源提交作为系统项目记忆保留下来；打开导入后的项目，填写其仓库根目录并选择 **Check imported baseline**。`SAME` 和干净的 `TARGET_AHEAD` 可安全继续，`TARGET_DIRTY`、`DIVERGED`、`SOURCE_MISSING` 会明确阻断自动应用并写入审计事件。

要把交接目录封装成适合复制到 Linux/macOS 的单个文件，先在 Projects 中创建 Handoff bundle，再运行：

```powershell
.\windows\export-handoff.ps1 -ProjectId "项目ID" -DestinationDirectory "D:\交接导出"
```

脚本默认选择该项目最新交接包，先调用 Hub 完整验证，再生成 ZIP 和同名 `.zip.sha256`。目标电脑应先核对 SHA-256，再解压到 handoff inbox 的一个直接子目录；ZIP 本身不能直接作为导入目录。也可用 `-HandoffId` 指定历史包。

在另一台 Windows 电脑上，可由安全导入器完成校验、解压和 Hub 导入：

```powershell
.\windows\import-handoff-archive.ps1 -ArchivePath "D:\收到的交接包.zip" -TargetProjectId "目标项目ID"
```

它会读取同名 `.zip.sha256`，限制条目数和解压后总大小，拒绝绝对路径、`..`、重复项、符号链接及缺少根清单的 ZIP，并先解压到 inbox 内的随机 staging 目录，完成后原子改名。`TargetProjectId` 可省略，此时使用清单中的原项目 ID；若 Hub 导入失败，已验证目录会保留在 inbox 供排查和重试。

Linux、macOS 或已安装 Python 3 的任意电脑使用同一套跨平台导入器：

```bash
python3 scripts/import-handoff-archive.py ./项目交接包.zip \
  --target-project-id 目标项目ID
```

默认读取旁边的 `.zip.sha256` 并连接 `http://127.0.0.1:4781`；可用 `--checksum`、`--hub-url`、`--bundle-name` 和 `--inbox` 覆盖。安全检查、随机 staging、原子切换与 Windows 导入器一致。

把仓库和项目代码移动到 Linux/macOS 后，可在仓库根目录初始化并运行当地平台：

```bash
bash ./unix/setup.sh --start-dir "$HOME/dpi-work" --provider openai
bash ./unix/install-local-service.sh
bash ./unix/status.sh
# 临时前台验证：bash ./unix/start-local.sh --no-open
```

安装器在 Linux 使用 systemd user service、在 macOS 使用 LaunchAgent，同时托管 Backend 与 Hub/Task Worker；任一进程退出时整组重启。

要求 Node.js 22.19+、npm、curl 和 Bash。`openai` 复用当地 `~/.pi/agent/auth.json` 的 Token/OAuth 登录；`openrouter` 要求环境中已有 `OPENROUTER_API_KEY`；`faux` 只用于无费用验证。脚本生成权限收紧的 `~/.dpi/backend.env`、本机网络配置、日志和 PID，不复制 A 电脑凭证。默认只监听回环地址。

在目标系统开始适配前生成结构化环境快照：

```bash
node scripts/scan-environment.mjs \
  --workspace /path/to/project \
  --output /path/to/environment.json
```

快照包含操作系统、CPU/内存、Node/OpenSSL、Git 工作区提交与脏状态，以及 npm、Python、C/C++、CMake、Docker、Rust、Java、NVIDIA 工具可用性；不读取环境变量值或 Provider 凭证。输出使用独占创建，不会覆盖已有报告。可把 JSON 作为 Artifact 上传并允许进入下一次交接包。

也可直接在 Projects → Artifacts 的 **Scan environment** 输入工作目录。Hub 在本机执行同一只读扫描器，将报告登记为 `environment-report` Artifact，计算大小与 SHA-256，并默认纳入下一次交接包；添加 Local Codex 后会自动预填它的工作目录。

创建交接包前会扫描明确允许导出的记忆和 Artifact。检测到私钥或常见 Provider/GitHub/AWS/Slack Token 时会在落盘前阻断，不生成半成品交接记录；应先从原始资料中移除秘密，再重新导出。扫描是防误传保护，不代替密钥轮换和人工复核。

Projects 的 Model usage 显示实际 Token 用量。项目右上角可设置滚动 24 小时 Token 上限；达到后，后续任务会在调用模型前暂停。还可设置 **Per-task token limit**：本机 Codex 的实时用量达到阈值时会取消当前回合并将任务暂停；若回合已执行命令或文件修改，则优先进入未知副作用核查，不能直接重跑。提高或清空限制后，在 Durable tasks 中点击 Resume 即可继续。

## 当前已经实现

- Coordinator 记忆检索同时限制条数和体积：单个大值最多返回 8,000 字符预览、原长度和 SHA-256，整个结果最多约 50,000 字符；达到体积上限时返回 `truncatedBySize=true` 并停止追加。
- Windows PowerShell 安装、启动、停止和状态检查，不依赖 `zsh`、`just`、`launchd` 或 `systemd`。
- Hub 的 Projects 界面：创建项目、绑定 Agent、设置角色、派发项目内任务。
- SQLite 项目注册表：项目、成员和路由事件持久化。
- Agent 工具 `list_project_agents` 和 `send_project_message`：Agent 能发现同项目成员并自主求助。
- Agent 工具 `list_project_memories` 和 `remember_project_fact`：Agent 只能读取共享事实与自己的私有事实；写入默认私有，只有 Coordinator 可发布共享事实，更新可携带版本防止覆盖并发修改。每次工具调用使用稳定 Request ID，同一调用的网络重放不会重复增加版本，ID 与参数不一致时会拒绝。
- Coordinator 工具 `create_project_agent` 和 `archive_project_agent`：可从项目中已有的 Local Codex 模板安全克隆临时 Agent；临时 Agent 完成作用域任务后自动归档，不长期占用活动成员列表。
- Local Codex Coordinator 也已接入 app-server Dynamic Tools，不再依赖 Pi 登录才能组建团队。其持久 Thread 可列出项目成员/任务、从已批准的 Local Codex 模板创建临时 Agent、异步派发 Durable Task、取消自己委派且不再需要的任务，并归档临时成员。`list_project_memories / remember_project_fact / expire_project_memory` 允许它主动读取共享及自身私有记忆，把架构、约束和决策写入版本化长期记忆，并将已过期结论保留历史后标记失效；记忆查询支持 2000 字符查询、确定性相关度排序和 1–200 条结果上限，返回 total/returned/truncated，避免大型项目一次塞回全部记忆。写入使用 Call ID 幂等，更新和失效支持版本校验，失效原因与发起者进入审计，共享与私有作用域明确分离。成员列表会返回执行工作区；本机可写临时 Agent 默认在干净 Git 根上获得独立受管 Worktree，显式 `shared` 才共享模板目录，远程或只读角色安全回退为共享串行。任务完成或取消后的自动归档，以及 Coordinator 主动归档，都会只清理该临时成员拥有且保持干净的 Worktree；脏工作区不会被静默删除。`send_project_task` 可在受控范围内指定优先级（-1000..1000）、最大尝试次数（1..20）、执行超时（1 秒..24 小时）和最多 64 个同项目前置 Task ID；Scheduler 在同一事务验证并写入依赖，未满足时进入 `WAITING_DEPENDENCY`，父任务完成后自动解锁。这些字段全部参与 Call ID 幂等核对。`cancel_project_task` 不能取消 Coordinator 当前回合或其他来源的任务，取消原因进入审计，且不会再给发起取消的 Coordinator 排一条冗余通知；运行中任务的既有副作用仍需按审计核查。所有工具强制限定当前项目、最多 8 个活动临时 Agent、用 Call ID 幂等且拒绝同 ID 改参数，调用与结果写入审计。旧 Coordinator Thread 会归档并一次性升级到工具版本 10；普通 Agent Thread 不重建。除协议级验证外，已用当前登录的真实 `gpt-6.1-sol` 跑通 Worker 原子领取、Thread 创建、`list_project_agents` 动态工具、审计和任务完成的完整数据库端到端链路，无需读取 Token。
- Coordinator 自主循环有三层硬限制：默认最多 8 层协调往返、每个 Coordinator 回合最多派发 12 个子任务、每个项目最多保留 64 个未结束任务。深度和根 Task ID 随委派及 `task_result` 回流持久传递；Call ID 重放仍可返回原任务，不会被当前限额误判。平台默认可用 `DPI_MAX_COORDINATION_DEPTH`、`DPI_MAX_DELEGATED_TASKS_PER_TURN`、`DPI_MAX_ACTIVE_PROJECT_TASKS` 配置；Projects 界面还能为每个项目独立覆盖，留空即继承平台默认。越界调用返回失败并进入工具审计，不会创建新任务。
- 委派任务最终失败时也会自动回流 Coordinator：源任务的 `FAILED` 状态和结构化 `task_failed` 通知在同一个 SQLite 事务提交，避免崩溃窗口丢信；通知保留根任务、协调深度、来源成员、Attempt/Fence 与分类错误。临时 Agent 无论成功还是最终失败都会归档其 Codex Thread 和成员，不会因失败长期占用团队名额。
- Coordinator 子任务准入也是原子的：Call ID 幂等核对、单回合派发计数、项目活动任务计数和任务插入共享同一个 `BEGIN IMMEDIATE` 事务。即使两个动态工具调用并发到达，也不能同时读取旧计数后越过项目上限。
- Coordinator 动态工具契约当前为版本 9；版本 8 的 Thread 会因新增 `get_project_team_plan` 在首次使用时归档并重建。前文的版本 8 描述仅记录上一阶段实现状态。
- 每次 Coordinator 回合的受保护任务上下文都会加入可信运行约束：协调根 Task、当前深度/上限、活动任务数/上限和本回合派发上限，并要求验收条件满足后汇总并停止派生任务。硬限制仍由 Scheduler 强制，提示只用于让模型提前规划和正常收敛。
- 跨 Agent 内容有明确的不可信边界：成功输出和错误文本使用 `BEGIN/END UNTRUSTED` 标记；结构化 Payload 只作为上下文数据并限制为 8,000 字符预览，超长内容保存长度和 SHA-256；项目/Agent 记忆标记为上下文数据而非可执行指令。下游 README、网页、代码注释或模型输出不能借回流自动升级为 Coordinator 指令。
- 临时 Agent 手动归档前会精确检查该成员的所有未结束任务；仍有排队、等待、运行或重试任务时拒绝归档并审计失败调用。任务成功或最终失败后的自动归档不受影响，从而避免成员先消失、任务后执行的悬空状态。
- 委派到远程设备的任务进入 `WAITING_DEVICE` 时，会在同一事务创建一次稳定的 `task_blocked` Coordinator 通知，包含设备、状态、源任务和协调链信息。设备恢复后源任务仍由 Monitor 自动重新排队；通知不会替代或消耗源任务的失败重试预算。
- 用户取消委派任务时，`CANCELLED` 状态与稳定的 `TASK_CANCELLED` Coordinator 通知同事务提交。排队中的临时 Agent 任务取消后由 API 归档成员；运行中的任务通过 Fence 让 Worker 中止模型回合，再归档 Thread/成员。Coordinator 的 `cancel_project_task` 复用相同终态清理：排队取消立即归档已经空闲的临时 Agent，运行中取消由被 Fence 中止的 Worker 收尾；同一临时成员仍有其他活动任务时不会提前归档。所有成员删除和归档路由统一拒绝仍有活动任务的目标，避免绕过生命周期检查。
- 运行中取消的通知会标记 `effectsMayPersist=true`：取消不会回滚已经完成的命令或文件变化，重试前应检查工具审计。若 Codex 回合在已观察到 `commandExecution` / `fileChange` 后异常断开或超时，Worker 不自动重试，而是进入 `PAUSED / UNKNOWN_SIDE_EFFECT`，复用现有“重试或标记完成”人工处理入口；纯推理阶段失败仍可按策略重试。
- 同一项目现在真实并行执行隔离的 Agent：Worker 默认每项目最多 2 个、全局最多 4 个、单 Worker 最多 4 个并发任务，可用 `DPI_MAX_PROJECT_RUNNING / DPI_MAX_GLOBAL_RUNNING / DPI_MAX_WORKER_RUNNING` 调整；Projects 界面的 `Concurrent project tasks` 可为单个项目覆盖平台值。Scheduler 在原子 Claim 中同时建立成员锁和 Codex 工作区锁：同一 Agent（尤其 Coordinator Thread）始终串行，两个成员指向同一 `cwd` 时也串行，只有不同 worktree/目录的成员才可并行。自动化把平台值设为 1、项目值设为 2，并以两个独立 worktree 验证任务同时处于 `RUNNING`。
- Projects 的 **Managed Git worktrees** 可从仓库根目录和基准 Commit 创建平台受管工作树；默认生成唯一 `dpi/<project>/<label>-<id>` 分支，目录位于 `%USERPROFILE%\.dpi\worktrees`。创建过程先持久化 `PROVISIONING` 再调用 Git，服务在中断后会验证目录、Git Root 和分支并恢复为 `ACTIVE` 或明确标记 `FAILED`。检查会报告 HEAD、脏状态和基准是否为祖先；选中 **Use for Codex** 会把该目录填入新 Agent 和交接蓝图绑定表单。工作树有未提交修改时，移除或删除项目会拒绝；干净工作树移除后分支仍保留，已提交成果不会随 Checkout 消失。项目最多同时管理 32 个活动工作树，创建、失败、检查和移除均有项目审计。
- 交接清单现在携带安全的项目资源策略：24 小时 Token 上限、单任务 Token 上限、协调深度、单回合派发量、活动任务数和项目并发数。目标电脑导入时逐项重新校验范围并恢复这些限制；Autonomy 仍强制降为 `SUPERVISED`，成员、Thread、工作目录和凭证仍不继承。
- Coordinator 通过 Dynamic Tool 派发的子任务会自动回流：子任务结果先以稳定 Task 级 Message ID 创建一个依赖源任务的 `task_result` 通知，源任务提交完成时通知转为 `QUEUED` 并由 Coordinator 继续规划。通知创建发生在完成提交之前且自身幂等；故障注入已验证“通知已创建但完成提交中断”后，执行回执重放不会再次调用模型、不会重复通知，也不会丢失结果。
- Agent 消息使用结构化信封：任务、结果、失败、阻塞、问题、审批、进度和上下文更新具有明确类型，并可携带 Message ID、Correlation ID 与 JSON Payload；工具重试不会重复创建同一任务或临时 Agent。
- 项目任务支持独立执行超时；到期后取消模型回合、记录 `MODEL_TIMEOUT` 和 Attempt/Fence，并释放 Worker 租约。Projects 的 Durable tasks 会显示已配置的超时秒数。
- Durable tasks 会直接显示结构化失败原因。限流、临时网络和超时允许有限重试；认证、配额、模型能力及审批类错误不会盲目重试。
- 可重试 Provider 错误不再固定每 2 秒撞击上游：Worker 按 Attempt 做有上限的指数退避，429 至少从 5 秒开始，识别错误文本中的 `Retry-After` 秒/毫秒/分钟提示，并加入由 Task ID、Attempt 和错误码生成的确定性抖动。普通退避最多 5 分钟，服务器提示与抖动后的总延迟最多 15 分钟；相同任务在 Worker 重启后仍计算出相同延迟。平台不会在未获用户允许时自动更换模型。
- Provider 熔断状态持久化在项目 SQLite：同一 Provider/Model 连续 3 次临时故障后默认打开 30 秒，后续任务转为 `RETRYING` 且 Attempt 标记 `WAITING_PROVIDER`，不会调用模型也不消耗失败重试预算。到期后通过事务只放行一个半开探测，失败则指数增加开放时间（最多 30 分钟），成功才关闭。每次状态转换带 Generation/Fencing Token，熔断前的慢请求不能覆盖新世代。`GET /api/provider-health` 可供本机监控读取；错误消息入库前会脱敏 Bearer、`sk-` Key 和常见 Token/API Key 参数。阈值可用 `DPI_PROVIDER_FAILURE_THRESHOLD / DPI_PROVIDER_BASE_OPEN_MS / DPI_PROVIDER_PROBE_LEASE_MS` 调整。
- 远程设备离线、未注册、认证失效、身份不匹配或版本不兼容时，任务进入持久化 `WAITING_DEVICE`，结束当前 Attempt、释放 Lease 并记录 `task_blocked`，但该 Attempt 不消耗模型/代码失败重试预算。Monitor 再次确认设备 `online` 后，Worker 自动恢复为 `QUEUED` 并以新 Fence 执行；不会在设备离线期间循环提交。自动化已用 `maxAttempts=1` 验证离线 Attempt 后仍可恢复并完成。
- Durable Worker 在模型成功返回后、提交 `COMPLETED` 前先写入按任务输入 SHA-256 绑定的执行回执。若完成提交中断，下一 Attempt 复用原 Submission/Answer 并写审计，不再次调用 Pi/Codex；回执创建仍受 Lease 与 Fencing Token 约束，旧 Worker 不能补写新回执。故障注入已验证 Codex 实际调用次数保持为 1。模型返回与回执落库之间仍属于无法由本地事务消除的外部系统窗口，Pi 使用稳定 Request ID 缩小该风险，Codex 的严格 Exactly-once 仍取决于上游原生幂等能力。
- `WAITING_APPROVAL` 会持久记录当前 Approval ID，并与 Task/Attempt/Fence 绑定。等待期间 Lease 过期并被新 Worker 接管时，尚未使用的旧审批会原子失效；已拒绝或撤销的审批终止任务；若旧审批已经消费但没有可复用的执行回执，平台将任务暂停为 `UNKNOWN_SIDE_EFFECT`，等待人工核对，绝不自动重放可能产生副作用的工具调用。
- `UNKNOWN_SIDE_EFFECT` 不能通过普通 Resume 绕过。Projects 中必须填写核验说明并明确选择“确认未执行后重试”或“确认已执行并完成”；选择、操作人、Approval ID 和说明写入项目审计。取消任务仍可直接使用，确认完成会正常释放依赖任务。
- Codex 工具事件同时进入独立 `project_tool_calls` 证据表：记录 Task、Attempt、Fence、Member、原始 Item ID、开始/完成状态和退出码，并将命令、结果、文件修改等内容脱敏后限制在 64 KiB。Bearer/API Key/Token 文本及 `authorization`、`apiKey`、`password`、`secret`、Cookie 等敏感字段会在持久化前清除。写入前重新验证运行中的 Attempt 与 Fencing Token，工具证据和项目事件在同一 SQLite 事务提交；重复事件必须内容一致。已经持久化且内容完全一致的传输重放在 Attempt 结束后仍可只读返回，任何新内容或修改仍会被过期 Fence 拒绝。界面可按 Test、Build、File change 和其他 Tool 过滤，平台 Observability 汇总运行中、成功、失败以及测试/构建通过失败计数。分类只表示实际运行了对应命令，不能替代测试覆盖率或人工质量判断。
- Local Codex 的角色权限现在与项目自主模式共同生效：成员持久保存 `ROLE_DEFAULT / READ_ONLY / WORKSPACE_WRITE` 权限档案。默认档案下，Coder、Developer、Engineer、Debugger、Tester 才是可写角色；Researcher、Reviewer、Architect、Documentation、Coordinator 以及未知角色一律保持 `read-only + never`。显式档案可安全覆盖自定义角色的名称推断，但项目处于监督模式时仍不能绕过按次审批。Coordinator 创建临时 Agent 时可指定档案，最终 Sandbox、Approval Policy 与档案记录在 Thread 审计事件中。远程 Pi Agent 仍使用其自身 `readOnly` 配置，后续要加入任务级策略覆盖，不能通过临时修改共享 Agent 配置模拟。
- Local Codex 成员的权限档案可在 Projects 成员卡中显式修改并保存；更新写入 `member.permissions.updated` 审计事件，失败时界面重新加载服务端值，不会保留看似成功的本地状态。远程 Pi 成员暂不显示这个控件，避免把尚未实现的任务级 Pi 权限覆盖误导成已生效。
- 临时 Agent 的权限上限同时比较显式 Profile 和角色的实际效果。`ROLE_DEFAULT` 不是固定等级：只读 Researcher/Reviewer 模板即使仍选择 `ROLE_DEFAULT`，也不能通过把临时角色改名为 Coder/Debugger/Tester 获得写权限；只有模板本身实际可写时才允许派生可写角色。Hub、后台 Coordinator Dynamic Tool 与 T3 Project MCP 共用同一判断函数。
- 远程 Pi 任务派发前会读取目标 Agent 的真实配置：监督项目、显式 `READ_ONLY` 档案或默认只读角色要求 `config.readOnly=true`。不满足时任务以非重试的 `POLICY_DENIED` 失败，模型不会被调用，平台也不会临时修改可能被其他项目共享的 Agent 配置。授权自主项目中的可写角色继续使用其正常配置。
- Projects 左栏的 Platform status 集中显示项目、活动/临时 Agent、运行/失败任务、待审批、Artifact 容量和近 24 小时 Token，用于快速判断多个项目是否正常运行。
- 项目记忆区分共享事实和 Agent 私有事实；相同公开 Key 可在不同作用域独立版本化，私有事实不会进入其他 Agent 上下文或跨设备交接包。
- URL Worker 注册：B/C 电脑可作为独立设备接入 A。
- 远程 Hub API 使用 Bearer Token；本机浏览器仍可直接使用。
- 每个设备的 Agent、会话、工作目录和数据库相互独立。
- 版本化项目交接目录：选择性导出有效记忆与 Artifact，记录协议版本、兼容版本、文件大小和 SHA-256。
- Windows 交接导出器：验证已有 Bundle 后生成单个跨平台 ZIP 与独立 SHA-256 文件；已通过真实生成、解压、清单和校验和比对。
- Windows 交接归档导入器：校验外层 SHA-256 和 ZIP 安全边界后原子放入 inbox，再调用既有清单/Artifact 验证器导入；真实正常包已恢复项目记忆，路径穿越包已被拒绝且未落盘。
- Python 3 跨平台交接导入器：Linux、macOS、Windows 使用同一标准库脚本完成校验、受限解压和 Hub 导入；已真实恢复项目记忆并拒绝路径穿越 ZIP。
- Linux/macOS 本地运行脚本：`unix/setup.sh`、`install-local-service.sh`、`run-local-service.sh`、`start-local.sh`、`stop-local.sh`、`status.sh` 提供独立凭证、依赖构建、开机启动、异常重启、PID 归属检查和健康探测；Task Worker 通过本机 T3 登录态执行，Linux/macOS 已完成真实 Backend/Hub 健康检查和本机多 Agent 回合验证。停止逻辑依赖真实 POSIX PID，因此不把 Git Bash 当作正式目标系统。
- T3 目录浏览兼容保护：三端 Runtime 启动时检查用户主目录与受管项目根的直接子项；仅对 T3 无法编码的纯空白名或控制字符名执行同目录原子恢复命名，内容不变，并在 `~/.dpi/logs/t3-browse-name-repairs.jsonl` 留下权限收紧的审计记录。Windows、Linux、macOS 当前检查均为零异常，Linux/macOS 合成故障已验证可恢复且文件不丢失。
- 跨平台环境扫描器：以结构化 JSON 记录系统、运行时、工具链、GPU 探测和 Git 基线，不读取秘密值且拒绝覆盖报告；已在当前真实工作树验证平台、架构、提交、脏状态和凭证文本缺失。
- 环境报告 Artifact 闭环：项目界面可对指定工作目录运行扫描，报告正文进入项目隔离 Artifact Store 并默认允许交接；自动化 Hub 测试与真实 API 均已验证下载内容、Git Revision 和 SHA-256。
- Git 基线与冲突预检：Git-aware handoff 固定干净 HEAD；导入后把源基线保存在目标项目的系统记忆中，不依赖源电脑交接记录。源端和目标端检查均区分同一提交、向前提交、脏工作树、历史分叉和缺少源提交；结果包含是否可安全继续并进入项目审计。SDK 自动化覆盖关键状态，Hub 端到端测试覆盖创建、导入和目标端检查，真实 API 已验证 `SAME`、`TARGET_AHEAD` 和两条审计事件。
- 交接运行时版本门禁：导入和重新验证都会检查协议、Schema、Exporter 版本及 `minimumRuntimeVersion`；未来版本要求高于当前 Runtime 时会在创建项目或写入 Artifact 前拒绝，避免旧节点误读新格式。自动化已覆盖重新计算合法哈希后伪造未来版本仍被拒绝。
- 远程设备独立认证：每台 Worker 使用自己的 Backend Token 与设备 ID 访问 A，Hub 将认证设备绑定到项目 Member 身份；支持按设备轮换和撤销，旧共享 Token 默认关闭。已通过真实 Tailscale 非回环地址验证合法 Membership 200、跨设备消息 202、缺失/错误/撤销凭证 401，以及跨设备冒认、伪造发送者和访问管理路由 403。
- Hub 错误状态规范化：底层网络错误可能携带非 HTTP `status: 0`，通用错误边界只接受 400–599，否则规范化为 400，避免 Express 再次抛出无效状态码。自动化已用不可达 Worker 回归验证。

## 一、中心电脑 A：本机使用

首次设置：

```powershell
cd C:\Work\durable-pi
.\windows\setup.ps1 -StartDirectory "C:\Work\Projects"
```

默认 Pi 设备使用 `faux` 回声模型，无需密钥，适合验证设备和路由。真实工作可改用 OpenRouter：

```powershell
$env:OPENROUTER_API_KEY = "你的密钥"
.\windows\setup.ps1 -StartDirectory "C:\Work\Projects" -Provider openrouter -SkipInstall
```

启动和停止：

```powershell
.\windows\start-local.ps1
.\windows\status.ps1
.\windows\stop-local.ps1
```

`setup.ps1` 会注册当前用户计划任务 `DurablePi-Local-Platform`：登录后自动启动本机 Backend/Hub，并每 5 分钟检查两个回环健康端点。只有健康检查连续失败时才调用受 PID 与仓库命令行双重约束的停止脚本，再隐藏窗口重启；正常服务不会被周期性重启。恢复记录位于 `%USERPROFILE%\.dpi\logs\dpi-ensure.log`。需要单独重装该任务时运行 `.\windows\install-local-autostart.ps1`。

也可以双击根目录的 `启动项目协作平台.cmd` 和 `停止项目协作平台.cmd`。控制台地址为 <http://127.0.0.1:4781>。

如果本机 Codex 已经登录，Projects 界面还可以直接添加 **Local Codex** 成员：选择当前可用模型、填写项目工作目录并添加即可。平台通过 `codex app-server` 复用当前登录，不读取或复制 Token，也不要求在 Pi CLI 中再次登录。Codex Thread 会持久恢复，删除成员或项目时自动归档。项目为 `Supervised` 时 Codex 使用只读 Sandbox，写入或命令升级会出现在项目 Approvals 区域，批准后只允许该次参数完全一致的操作；切换到 `Authorized autonomy` 或 `Restricted unattended` 后允许在该工作目录内执行常规写入，越界权限仍需审批。

若同一项目需要多个 Coder 并行写入，先在 **Managed Git worktrees** 填写主仓库根目录、标签和基准（通常为 `HEAD`）创建独立工作树，再选择 **Use for Codex** 后添加对应 Local Codex 成员。不要让两个可写 Agent 共用同一个工作目录；Scheduler 会把共享目录串行化，而独立工作树才允许真实并发。

Hub 会把 `codex app-server model/list` 规范化为带缓存的本机模型目录。创建成员和每次执行前都会确认所选模型仍属于当前登录可用模型；客户端伪造或已经下线的模型会被永久拒绝而不会消耗重试次数。模型列表只证明“可用”，不会被当成工具能力证明：文字、图片和推理能力按 Codex 元数据登记，Dynamic Tools 只有经过本平台真实端到端验证的模型才标记为 `supported`。目前 `gpt-5.6-sol`、`gpt-6.1-sol`、`gpt-6.2-sol` 和 `gpt-6.2-astra` 均已通过真实 Dynamic Tools 回合；新建的本机 Codex Agent 默认使用 `gpt-5.6-sol`，默认推理强度为 `medium`，服务层为 `fast`（T3 中显示为 Fast，底层响应可显示 `priority`）。三端 Runtime 启动时会把空闲项目的活动 Codex 成员迁移到设备配置的 Coordinator 模型，并记录审计事件；忙碌项目等待下次安全启动再迁移。未知能力保持 `unknown`；因此 Coordinator 只能使用已验证模型，普通 Local Codex 成员仍可使用目录中的其他模型。临时 Agent 不能取得 Coordinator 控制角色。

远程 Agent 不盲目继承 Windows Coordinator 的模型。每个远程资料源把实测模型清单与自己的 T3 Environment 绑定；`materialize_durable_remote_agent` 强制显式传入模型，并在访问远端仓库前确认该模型已经在目标设备验证。当前 Windows、Linux 和 macOS 均已验证并统一使用 `gpt-5.6-sol`；远程派发仍会逐设备校验实测模型清单，不能因为全局默认相同就跳过能力检查。

Coordinator 可先调用 `list_durable_execution_targets` 获取当前项目允许的远程 Source、T3 Environment、设备实测模型及 T3 当前链接状态；工具通过本机 T3 控制面读取 `reachable`/离线快照，不探测 SSH、不读取目标文件系统，也不暴露物理根目录。T3 状态暂时不可用时仍返回静态目标并标记 `liveStatusAvailable=false`，不会把探测故障伪装成设备离线。已用真实 `gpt-5.6-sol` T3 回合验证 Linux/macOS 两个目标及其设备模型清单。

远程模型证据不是只在创建 Agent 时检查一次。Scheduler 每次领取远程 Codex 任务后都会重新读取目标 Environment 当前绑定及 `verifiedModels`，并要求 Agent 工作目录只能由唯一一个当前项目资料源的远端根目录拥有；Environment 相同但资料根或策略不同的来源不会被混为一台目标，匹配不出或匹配歧义都会停止派发。随后平台逐一过滤主模型与显式备用模型；已撤销或属于另一台设备的模型不会发出请求，所有候选失效时任务以不可重试的能力错误停止。自动化已验证 Linux 主模型不再获准时，只会切换到该 Linux 目标仍明确验证的备用模型。

过期任务只能在执行身份完全一致时续接原 T3 Run：Provider、实际模型和 Environment 任一变化，Scheduler 都不会恢复旧 Run 或启动一个看似等价的新 Run，而是把任务暂停为 `UNKNOWN_SIDE_EFFECT` 等待核对。这避免租约过期后用已撤销模型继续运行，也避免同一任务在新旧设备身份下产生两份有效副作用。

Local Codex 创建表单可显式启用 **Automatic model fallback**，最多选择 5 个目录内模型；默认关闭，选择顺序按界面模型目录顺序持久化。每个备用模型在成员创建/更新和每次任务执行前重新校验当前登录可用性；Coordinator 的所有候选还必须通过 Dynamic Tools 平台实测。平台只会在模型调用前发现前序候选不可用、能力不足或熔断时选择下一个候选，不会在模型请求已经发出后于同一 Attempt 内偷偷切换。切换模型时旧 Codex Thread 会归档，新 Thread 记录实际模型、主模型、Fallback 标记与原因；主模型恢复后下次任务自动按优先顺序返回主模型。临时 Agent 完整继承模板的备用策略，策略变更和实际选择都进入审计。

运行数据和日志位于 `%USERPROFILE%\.dpi`。设备令牌和 Hub 令牌只保存在 `%USERPROFILE%\.dpi\backend.env` 或 SQLite 注册表，不写入 Git。

项目、任务、记忆、审批和审计数据库会备份到 `%USERPROFILE%\.dpi\backups`。Hub 启动时如果最近 6 小时没有备份会自动创建，持续运行期间也会每 6 小时在线生成一致性快照；Projects 界面可随时手动创建。关闭 Hub 会先停止定时器并等待已提交的备份完成，再关闭数据库。间隔可用 `DPI_BACKUP_INTERVAL_MS` 在 1 分钟至 7 天范围内调整。每份备份都会运行 SQLite `quick_check`、`foreign_key_check` 并计算 SHA-256，默认保留最新 14 份。

每份新备份还会生成同名 `.sqlite.files` 目录，保存有效及保留的过期 Artifact 正文，以及三设备资料源/目标 Environment/实测模型清单 `data-sources.json`；清单固定记录大小和 SHA-256。任一 Artifact 或配置无法验证时不会报告备份成功。当前备份 Manifest 为 Schema 3；恢复仍兼容旧 Schema 1/2。移动备份时必须同时携带 `.sqlite` 和同名 `.sqlite.files` 目录，凭证文件 `backend.env` 明确不进入备份。

离线恢复时先停止服务，再传入界面列出的备份文件名：

```powershell
.\windows\stop-local.ps1
.\windows\restore-project-backup.ps1 -BackupName "projects-2026-11-17T04-48-58.993Z-manual-8b1918b1.sqlite"
.\windows\start-local.ps1
```

恢复脚本会先在 backups 目录保存当前数据库副本，并在替换前后验证 SQLite 完整性；随后验证 Artifact/配置清单和全部哈希，在临时目录重建正文，将数据库中的绝对 `storage_path` 改写到当前电脑，并恢复资料源配置；原数据库、Artifact 目录和既有资料源配置均先保留安全副本。任一步失败会回滚文件目录、配置和数据库；服务仍在线时会拒绝恢复。

不影响在线平台的恢复演练可直接针对最新备份执行。脚本把备份复制到工作区 `临时文件` 下的隔离 DPI 目录，运行真实恢复流程，再逐表比较逻辑内容并验证每个 Artifact 与资料源配置的路径、大小和 SHA-256，成功后删除演练目录：

```powershell
.\windows\test-backup-restore.ps1
```

长时间稳定性可用只读 Soak 脚本持续检查 Backend、Hub、项目投影、T3 Environment 和 SQLite 完整性；`-RequireRemoteLinks` 会要求 Linux/macOS 两条链接在每个采样点都可达：

```powershell
.\windows\soak-platform.ps1 -DurationSeconds 3600 -IntervalSeconds 15 -RequireRemoteLinks
```

Scheduler 的多连接压力验证可在隔离数据库中运行 6 个 Worker、400 个任务，并注入租约过期和可重试失败；脚本最终检查全部任务唯一完成、旧 Fence 写入被拒绝及 SQLite `quick_check`：

```powershell
npx tsx .\apps\dpi-playground\scripts\verify-scheduler-stress.ts
```

## 二、把中心 Hub 开放给 B/C

推荐先让三台电脑加入同一个 Tailscale 网络，使用各自的 Tailscale IP。不要把 4780/4781 端口直接暴露到公网。

在 A 上重新设置 Hub 监听并重启：

```powershell
.\windows\stop-local.ps1
.\windows\setup.ps1 -StartDirectory "C:\Work\Projects" -HubHost 0.0.0.0 -SkipInstall
.\windows\start-local.ps1
```

假设 A 的 Tailscale IP 是 `100.64.0.10`，导出 B/C 设置所需的 Hub 地址：

```powershell
.\windows\show-hub-connection.ps1 -PublicUrl "http://100.64.0.10:4781"
```

默认输出不含共享密钥。每台 Worker 使用自己的 Backend Token 作为 Hub 设备凭证；A 注册该 Worker 后才允许它调用项目协作接口。远程请求缺少设备 ID、Token 错误或设备已撤销时返回 `401`。

## 三、Worker 电脑 B 或 C

把同一份仓库复制或克隆到 Worker，安装 Node.js 22.19 或更高版本。在 B 上执行：

```powershell
cd <B电脑上的durable-pi目录>
.\windows\setup-worker.ps1 `
  -DeviceId "worker-b" `
  -HubUrl "http://100.64.0.10:4781" `
  -StartDirectory "D:\B电脑资料"
.\windows\start-worker.ps1
```

在 C 上把设备 ID 改为 `worker-c`，工作目录改为 C 的资料目录。设备 ID 必须唯一。

假设 B 的 Tailscale IP 是 `100.64.0.11`，在 B 上生成注册信息：

```powershell
.\windows\show-worker-registration.ps1 -PublicUrl "http://100.64.0.11:4780" -Name "资料电脑 B"
```

回到 A，将输出中的值传给注册脚本：

```powershell
.\windows\add-device.ps1 `
  -DeviceId "worker-b" `
  -Name "资料电脑 B" `
  -Url "http://100.64.0.11:4780" `
  -Token "B输出的token"
```

对 C 重复一次。Worker 停止命令是：

```powershell
.\windows\stop-worker.ps1
```

## 四、创建互不干扰的项目

新建项目可选择 Blank、Web application、Python project、Technical research 或 Cross-platform software 模板。模板由 Hub 服务端应用监督模式、协调深度、单回合派发数、活动任务数和并发数等保守默认值，并把建议角色与最小权限冻结为项目团队计划；`templateId` 和计划随项目持久化并进入交接清单，目标电脑导入后仍能识别来源模板且不会受未来模板修改影响。Coordinator 的 `get_project_team_plan` 可查看角色是否已绑定、匹配成员及权限是否一致，调用同样进入动态工具审计。项目、`project.created` 和 `project.template.applied` 在同一 SQLite 事务提交。模板不会在创建项目时启动全部角色；按需实例化写角色时，干净且已有提交的 Git 根目录默认自动分配受管 Worktree，非 Git 或带本地未提交内容的目录保留共享工作区并由 Scheduler 串行化，避免丢失本地改动。

如果写 Agent 先在非 Git 或脏目录中以共享方式建立，之后仓库已提交并清理，可由 Coordinator 调用 `isolate_durable_agent_workspace`。工具只迁移冻结团队中的本机空闲写角色，先确认没有活动任务，再创建确定性受管 Worktree并更新成员工作目录；远程、临时、只读、计划外或忙碌成员一律拒绝，重复调用返回原 Worktree。

成员工作目录发生变化时，平台会在同一次数据库更新中解除旧 Codex/T3 Thread 绑定；下一任务必须为新目录创建 Thread，旧会话只保留作审计，不能被错误续接。Coordinator 通过 `cancel_durable_task` 取消处于用户输入或审批等待的任务时，也会按 Attempt 中冻结的 Thread/Run 调用 T3 Interrupt，并把结果写入审计，避免数据库已取消但审批弹窗仍能执行。

1. 在 A 打开 <http://127.0.0.1:4781>。
2. 在设备树分别选择 A、B、C，给每台设备创建属于该项目的 Session。
3. 点击顶栏 **Projects**，创建“项目 1”。
4. 依次选择三个 Agent，把它们加入“项目 1”，设置 coordinator、worker、researcher 或 reviewer 角色。
5. 创建“项目 2”，绑定另一组 Session/Agent。
6. 在 Projects 中直接派发任务，或让 Agent 调用 `list_project_agents` 后使用 `send_project_message`。

项目是通信边界，不是文件同步盘。B 的 Agent 可读取 B 上被授权的工作目录，提炼结果后发给 A；A 无需挂载 B 的磁盘。

## 网络和安全边界

- Worker 的 `/v1` API 使用各自独立的 Bearer Token。
- Hub 的远程协作请求使用 `X-DPI-Device-Id` 与该设备在 A 的 Network Registry 中登记的独立 Token。Token 可按设备轮换或清空撤销，且请求身份必须与项目成员的 `deviceId` 一致；凭证只能访问成员查询、Agent 记忆和项目消息路由，不能远程注册设备或管理 Hub。旧 `DPI_HUB_TOKEN` 只有在 A 显式设置 `DPI_ALLOW_LEGACY_HUB_TOKEN=1` 时才接受，默认关闭。来自本机回环地址的浏览器请求无需令牌。
- Hub 注册表不会把设备令牌返回给浏览器。
- 建议用 Tailscale/WireGuard，并把 Windows 防火墙规则限制在该虚拟网卡或指定 IP。
- 当前版本尚未实现用户账号、组织权限和端到端消息加密，因此不应直接部署到公网。

## 诊断

中心电脑：

```powershell
.\windows\status.ps1
Get-Content "$env:USERPROFILE\.dpi\logs\dpi-backend-error.log" -Tail 100
Get-Content "$env:USERPROFILE\.dpi\logs\dpi-hub-error.log" -Tail 100
```

Worker：

```powershell
Invoke-WebRequest http://127.0.0.1:4780/healthz
Get-Content "$env:USERPROFILE\.dpi\logs\dpi-worker-error.log" -Tail 100
```

如果设备显示 unauthorized，重新从该 Worker 导出注册码并在 A 上执行 `add-device.ps1`；如果显示 offline，检查 Tailscale 连通性、端口和 Windows 防火墙。

## 五、Windows 本地接入 Gemini（仅 Gemini Pro 订阅）与 DeepSeek Harness（`dsh`）

平台默认保持 Coordinator 和常规角色使用 Codex（`gpt-5.6-sol`），同时支持在 Windows 本机接入 **Google Gemini** 和 **DeepSeek Harness**：

1. **Google Gemini（直接复用桌面 Google Antigravity 登录态，不走 API Key）**：
   - 直接复用本机已安装并登录的 **Google Antigravity**（`%LOCALAPPDATA%\Programs\antigravity\resources\bin\language_server.exe agentapi` 与 `~/.gemini/antigravity`），无需安装 `@google/gemini-cli` 或配置 API Key。
   - 平台启动 `AntigravityClient`（Runtime 明确登记为 `antigravity`）时会主动清除 `GEMINI_API_KEY` / `GOOGLE_API_KEY` 等环境变量，确保绝不误走按量 API 计费。只读角色强制 `--profile=research`（只读无网络沙箱），并在实时解析 `transcript.jsonl` 工具调用时校验所有文件路径均严格落在项目工作目录（及受管 Git worktree 的 `.git` 公共目录）内，禁止无沙箱 Shell 工具，越界时立即通过进程树终止（`taskkill /T /F`）阻断。
2. **DeepSeek Harness（`dsh headless --json`，复用桌面登录态或凭据库）**：
   - 本地 DeepSeek 任务通过独立的 `DeepSeekHarnessClient`（Runtime 明确登记为 `deepseek-harness`）调用 `dsh --profile headless --json`：
     - 自动复用桌面 **DeepSeek Harness** 登录态（`~/.dsh/.credentials.yaml` 中的 `deepseek-account` 令牌或本地凭据库），也兼容 `DEEPSEEK_API_KEY`；
     - 支持 `--session-id <id>` 持久会话恢复；
     - 严格映射平台权限边界：只读角色/只读模式强制 `--permission-mode read-only --approval-policy never`；可写角色强制 `--permission-mode workspace-write --approval-policy never`，仅在受管 Git worktree 下为所属仓库 `.git` 目录追加 `--add-dir`；
     - 解析 NDJSON 事件流写入工具审计（`ProjectToolCallStore`）、Token 计量与 Durable 执行回执（Execution Receipt），取消或超时时终止完整进程树。
3. **基于真实运行证据的模型能力发现**：
   - 平台不硬编码虚构的模型目录或上下文参数，而是从本机 **Google Antigravity** 的真实会话数据库（`~/.gemini/antigravity/conversations/*.db`）与 **DeepSeek Harness** 的真实会话投影记录（`~/.dsh/storages/session_projcache/sessions/*.json`）中自动发现已验证模型（`verifiedModels`）与真实能力，未实测维度保持 `null` / `"unknown"`。
4. **可选本地角色默认映射**：
   - 如需按角色自动选模型，可在 `.env` 中设置 `DPI_ROLE_MODEL_MAP_JSON`（例如 `{"reviewer":"deepseek/deepseek-flash","researcher":"google/gemini-2.5-pro"}`），不配置则所有角色保持 Codex 默认。
5. **远端 Linux / macOS（只配 DeepSeek 兜底，一键命令）**：
   - 远端不启用 Gemini；平时继续用 Codex，万一以后远端 Codex 没额度，只需在 Windows 上执行一条命令为远端开启 DeepSeek 兜底：
     ```powershell
     .\windows\setup-remote-deepseek.ps1 -SshHost durable-linux
     ```
   - 然后在 `C:\Users\admin\.dpi\data-sources.json` 中把对应模型加入远端的 `verifiedModels`，即可直接派发或作为远端 Codex 额度耗尽时的自动降级备用模型。
