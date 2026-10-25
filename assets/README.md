# 牛七七模型动作对照表

这张表是当前代码与 GLB 动作的唯一快速对照，代码或模型动作发生变化时同步更新。

| 模式 | 玩家指令 | 工具 action | 使用模型 | 使用动画/实现 | 结束后 |
| --- | --- | --- | --- | --- | --- |
| idle | “向左走” | `left` | `idle.glb` | `Walk_Turn_Right`（按实际视觉方向映射） | 回到屏幕中央初始位置 |
| idle | “向右走” | `right` | `idle.glb` | `Walk_Turn_Left`（按实际视觉方向映射） | 回到屏幕中央初始位置 |
| idle | “向前走” | `forward` | `idle.glb` | `Walking` | 回到屏幕中央初始位置 |
| idle | “向后走”、“向后退” | `backward` | `idle.glb` | `Walking`（idle.glb 没有专用后退片段） | 回到屏幕中央初始位置 |
| idle | “转圈” | `spin` | 代码 | 聊天圆周动作 | 回到屏幕中央初始位置 |
| idle | “跳跃” | `jump` | `idle.glb` | 优先 `Regular_Jump`，否则 `Happy_jump_f` | 回到屏幕中央初始位置 |
| idle | “跳舞” | `dance` | `idle.glb` | `Hip_Hop_Dance_1` / `Hip_Hop_Dance_3` 随机 | 回到屏幕中央初始位置 |
| idle | “向左走” | `left` | `idle.glb` | `Walk_Turn_Left` | 回到屏幕中央初始位置 |
| idle | “向右走” | `right` | `idle.glb` | `Walk_Turn_Right` | 回到屏幕中央初始位置 |
| idle | “向前走” | `forward` | `idle.glb` | `Walking` | 回到屏幕中央初始位置 |
| idle | “向后走” | `backward` | `idle.glb` | `Walking` | 回到屏幕中央初始位置 |
| idle | 无互动 3 秒 | 本地闲置调度 | `idle.glb` | 排除 `Running`、`Walking` 后随机播放 | 停 0.5 秒后再随机 |
| idle | 与牛七七说话 | 本地语音状态 | `idle.glb` | `Talk_with_Hands_Open` 循环 | 说话结束后重新计时 |
| game | “向左走” | `left` | `game.glb` | `Running`（玩家视角 x-） | 完成步数后结束 |
| game | “向右走” | `right` | `game.glb` | `Running`（玩家视角 x+） | 完成步数后结束 |
| game | “向前走” | `forward` | `game.glb` | `Running`（玩家视角 z+） | 完成步数后结束 |
| game | “向后走” | `backward` | `game.glb` | `Walk_Backward`（玩家视角 z-） | 完成步数后结束 |
| game | “转圈” | `spin` | `game.glb` | `Walking` + 本地圆周路径 | 回到起点 |
| game | “跳跃” | `jump` | 不允许 | 游戏模式拒绝 | 无 |
| game | 摘苹果 | 碰撞自动触发 | `game.glb` | 无角色摘取动作；苹果飞入口袋 | 得分 +1 |

两套模型分工：聊天/闲置使用 `idle.glb`，开始抓苹果游戏后使用 `game.glb`。游戏时钟、苹果生命周期、碰撞和计分全部由本地 `GameEngine` 控制。
