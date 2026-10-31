# Round 1 reference review

Actual comparison: round-0 A and round-1 B, images 01/02/04/07/11/13 and manifests. No production edit during this review.

**任务判断：保留 B。** Wide 02 与 embedded-380 13 都能同时显示问题、完整回答和 composer；A 的 380px 截图开头已经滚出问题，三层 header 占去约 170px。B 的单一标题、画布上的回答与中性用户气泡更接近已查看的 ChatGPT companion。来源控件移到下一次请求旁，也符合 NotebookLM 将来源选择与 composer 关联的模式。

**解决与剩余。** B 去掉了 transcript、scope、header 的重复卡片框；长论文只有一处身份标题，来源改用短标签。Dark 11 的正文、输入、发送对比清晰，属于有效的独立暗色映射。Native manifest 记录 root 13.3333px、font-scale 1.2、panel 14px；视觉上的正文缩小因此有实际运行依据。仍需保留 Zotero 的证据回链能力；这组 fixture 没有可点击页码引用，不能从截图宣称该流程已验证。

**新回退。** B composer 的两个连续“+”没有提供两个不同任务，削弱入口含义。Wide 的 New/History 在左栏与标题旁重复；ChatGPT 的历史栏参考是可收起导航，不需要两套并列入口。Embedded Paper 看起来像静态标签，作用域切换发现性不足。Error 07 的红色状态仍截断为“Connecti…”，正文虽说明中断，却没有显眼的直接重试动作；这不是完成恢复流程的证据。

**具体取舍。** 保留当前 type scale、单一身份行、无框回答、中性气泡、来源靠近 composer、黑色发送及暗色反转。撤销双“+”与 standalone 重复 New/History。不要恢复 A 的放大正文或多层框线。

**下一轮优先。** 先让下一步明确：一个有名称的添加入口、窄屏完整可读的失败信息和直接重试；随后补作用域切换箭头与展开来源/More 的实际截图，确认没有被 composer 或 panel 裁切。
