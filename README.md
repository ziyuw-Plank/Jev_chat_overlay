# Jev Chat Overlay

安卓聊天意图分析悬浮窗。在微信、TIM、QQ 当前打开的对话里，读取对方刚发的文字、截图和表情包，拆成几条互斥假说，用 Jev 打出百分比，再给一句可以复制的建议回复。只分析，不自动发送消息。

**Jev Chat Overlay** is an AutoJs6 floating window for Android chat apps. It reads the open conversation, scores mutually exclusive readings with Jev, and suggests one reply. It never sends a message for you.

## 关键词

AutoJs6、安卓悬浮窗、聊天分析、意图识别、微信、TIM、QQ、表情包识别、截图识字、OCR、无障碍、建议回复、不自动发送、Jev、DeepSeek

AutoJs6, Android overlay, chat intent, WeChat, TIM, QQ, sticker recognition, screenshot OCR, accessibility, suggested reply, no auto-send, Jev, DeepSeek, hypothesis scoring

## 准备

1. 手机安装 [AutoJs6](https://github.com/SuperMonster003/AutoJs6)，打开无障碍，允许悬浮窗和截图。
2. 把 `jev-chat-overlay.js` 放到手机 `/sdcard/Scripts/`。
3. 打开脚本，填两把密钥：

| 配置 | 位置 | 申请 |
| --- | --- | --- |
| `CONFIG.JEV.apiKey` | [TypeSafe](https://www.typesafe.ai/) | Jev，`jev-latest` |
| `CONFIG.LLM.apiKey` | [DeepSeek](https://platform.deepseek.com/) | `deepseek-flash`，用来读图和写假说 |

占位符是 `PASTE_TYPESAFE_API_KEY_HERE` 和 `PASTE_DEEPSEEK_API_KEY_HERE`。不要把填好的密钥提交回仓库。

## 使用

在微信、TIM、QQ 或其他聊天界面运行脚本。

- 拖动整条控制栏
- **J**：分析当前屏幕上的聊天
- **◉ / ○**：隐藏或恢复标注
- **≡**：选择并复制一条建议动作
- **×**：清空标注

换到另一个应用后，旧标注会清掉，控制栏还在。同一个应用里换聊天不会退出脚本；换完对话后点一次 J。

## 它在做什么

1. 用无障碍找中间的消息列表和底部输入框，不按包名写死坐标。
2. 文字走无障碍，读不到再 OCR。
3. 图片和表情包截下来交给 DeepSeek 看画面，不靠旁边的字猜。
4. DeepSeek 为每条对方消息写 2 到 4 个互斥假说。
5. Jev 给这些假说打百分比。
6. 再写一句建议动作：闲聊就短回，对方在加需求或压时间才划边界。

## 它不是什么

不是自动回复、不是群发、也不会替你点发送。建议动作要自己复制进输入框。
