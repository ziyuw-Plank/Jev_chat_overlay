# jev-chat-overlay

AutoJs6 聊天悬浮层。看当前聊天里对方的文字和图片，拆成几条互斥假说，交给 Jev 打百分比，再写一句建议动作。

不自动发送任何消息。

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
