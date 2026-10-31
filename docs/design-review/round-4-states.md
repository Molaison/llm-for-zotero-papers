# R4 最终状态与回退审查

A 使用冻结的 R3 生产代码新增实测 `round-3-stress`，B 为 `round-4`。实际查看两侧 `13/20/22/24/25`，另检查 B 的来源/More 展开与 JSON。B 原生套件通过，26 张截图，32.2 秒。

1. **任务哪个更好。** B 搜索摘要去除 Markdown 星号，匹配高亮仍准确；中文 `22` 的 Auto 改为“自动”。最实质的键盘改善是稳定顺序：A 诊断从 input、Close、result 三项增长到含 Delete 的四项；B 初始与聚焦后均四项，浅/深色 `stableFocusSet=true`。焦点边框从 native auto 1px 变为明确的 solid 2px，Delete 仍在 popup 内。

2. **解决与剩余。** 搜索的不存在查询、真实匹配、高亮、正反 Tab、非输入框 Escape 和返回真实触发器均通过原生断言。来源和 More 的真实 summary 打开、Escape 关闭及焦点返回保持；380px 浮层分别为 320×92、268×233px，没有横向页溢出。历史恢复 Retry 的 XHTML namespace 已修，既有 namespace 测试及源码执行状态检查通过；本套件没有制造数据库读失败，因此不宣称验证了真实故障恢复全链路。

3. **是否有新回退。** 配对状态未发现新增的功能或布局回退。`25` 在字体压力下 A/B 几何相同：model 192.4×34px、Send 32×32px，Send 右缘 363px，页面 scrollWidth=clientWidth=380；完整模型名保留在 accessible name，视觉截断不挤走 Send。`24` 背景的局部中英混排来自套件先切中文再局部重渲染的测试顺序，不将其误判为生产回退；真实中文比较依据 `22`。

4. **保留/撤销。** 保留 R4 的稳定焦点集合、明确焦点环、纯文本搜索摘要、中文自动标签和 namespace 修复。没有证据要求撤销 R4；也不建议再为截图做无目标微调。

5. **验收限制。** 字体压力使用真实插件偏好 150%，即基线 120%的 1.25 倍，不是 OS zoom；长模型名是实际配置中临时写入的 fixture，未调用该模型。`23` 已显式标记 `componentOnly/excludedFromProductAB`，不作为真实无选择入口的验收依据。删除只聚焦未执行，远端同步、真实 LLM 和用户库写入未在此运行。最后交由现有原生 workflow、全量单元、lint/build 完成整体验收，不重复启动 native。
