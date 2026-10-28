# Round 1 · 信息架构与任务完成审查

A：`evidence/round-0`。B：`evidence/round-1`。实际查看同名 `02-paper-conversation-wide.png`、`13-embedded-paper-380.png`、`01-paper-empty-wide.png`，并补看 B 的 `04-paper-conversation-narrow.png`、`09-library-empty-wide.png`。结论：保留 B 的结构，下一轮修复控件发现性。

| 用户任务 | 更好版本与证据 |
| --- | --- |
| 确认正在讨论哪篇论文 | B。wide 中原先外层标题、scope 卡片、source 行三次重复长标题，变成一个安静身份行；empty 首次发送前也能看到论文标题。 |
| 阅读回答并提出追问 | B。wide 同时呈现用户问题与完整回答；A 的大字号和多层容器挤压了问题区域。380px 中 B 保留完整错误说明、输入框和 Send。 |
| 确认下一次请求的材料 | B。Paper sources / Text 与输入框相邻；A 的来源在顶部。B 的双“+”却使添加入口看似两个操作，需修。 |
| 切换 Paper / Library | B 的 wide 更一致，embedded 尚未解决。B 不再混用 Papers、Paper chat、Library chat；380px 的 Paper 胶囊没有箭头，仍像静态标题，用户难以发现可切换。 |
| 找回历史并开始新会话 | 现有证据不足以判定交互完成。B 保留左栏 New/Search，但展开左栏时顶部又有 +/clock，重复入口仍在；收起左栏后必须保留顶部入口。 |

已解决的主要问题是标题竞争、阅读层级和输入材料位置。剩余问题是 scope 切换发现性、添加材料的双加号，以及展开侧栏下重复导航。新的明确回退是双加号；不能用“更简洁”解释它。

保留 B 的短 scope 标签、单标题、无框正文、composer source 和稳定 Send。撤销重复加号的表现；仅在 standalone 侧栏展开时隐藏重复 New/History，收起时保留。下一轮最高优先级是让“添加什么、切到哪里”可见并可操作，补采 More、Sources、scope 展开与 collapsed-history 状态。当前截图不证明未展开菜单、远端同步或真实模型请求可用。
