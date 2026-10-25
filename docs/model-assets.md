# 当前模型与动作

## 资源分工

| 文件 | 用途 | 骨骼 | 动画 | 文件大小约 |
| --- | --- | ---: | ---: | ---: |
| `assets/game.glb` | 抓苹果游戏 | 28 | 7 | 7.1 MiB |
| `assets/idle.glb` | 聊天、主动表演及闲置轮播 | 38 | 13 | 11.3 MiB |

两份各含模型、贴图和骨骼，由两个独立的 `ModelRig` / `AnimationMixer` 控制，不能跨用动画。两者都归一化为 3.2 单位高、脚底落地；仅当前模式的模型显示并更新。异步加载只替换所属模式，另一个模式不借用其骨架。模式切换先取消技能、归还动画控制权，再显示目标模型；目标资源未加载或加载失败时显示既有程序化兜底牛。旧 `assets/niu_qi_qi.glb` 保留为历史回归测试夹具，网页不再加载它。

Vite 通过静态 `new URL(..., import.meta.url)` 引用两份资源，构建会同时生成带哈希的独立 GLB，`npm run server` 从 dist 提供，不依赖 Downloads 绝对路径。首次下载总量约 25 MiB，实际 iPhone 加载时间和内存仍需真机验证。

## 游戏模型片段

`Running`、`Walking`、`Run_Turn_Left`、`Run_Turn_Right`、`Walk_Backward`、`Walk_Turn_Left`、`Walk_Turn_Right`。

正常移动播放 Running，向后移动播放 Walk_Backward，疲惫和绕圈播放 Walking。四个方向始终按玩家画面坐标执行，不追加转身和回正；左右移动暂用 Running 表现，向后移动使用 Walk_Backward。单个普通游戏动作最多执行 5 秒，超时会取消当前动作和等待队列，避免旧指令长尾；spin 仍使用完整圆周时长。水平根位移锁定，规则层仍是位置、碰撞和得分的唯一来源。

Regular_Jump、抓墙和挥拳等虽在文件中，不因此自动新增工具或改变抓取规则。游戏不需要跳跃或摘苹果动作；苹果由碰撞规则自动抓取。

## 闲置模型片段与顺序

自动闲置从 `idle.glb` 动画列表自动生成：排除 `Running` 和 `Walking`，其余动作每次随机选择。这样更换 idle.glb 后不需要再改代码列动作名。每段完整播放一次，动作结束后暂停 0.5 秒再随机衔接下一段。仅聊天模式、页面在前台且双方静默三秒时启动，不依赖灵矽连接是否已经就绪。说话时停止随机闲置，循环播放 `Talk_with_Hands_Open`；说话结束后重新等待三秒并随机选择。切入游戏后停止并隐藏 idle 模型，返回聊天后重新随机；主动技能优先。

主动 dance 只从 `Hip_Hop_Dance_1`、`Hip_Hop_Dance_3` 随机选择，排除加载较慢的 `OMG_Groove`；聊天模式的 jump 指令优先播放 `Regular_Jump`，没有该片段时回退到 `Happy_jump_f`。当前文件包含 `Happy_jump_f`、`Hip_Hop_Dance_1`、`Hip_Hop_Dance_3`、`Idle_10`、`Idle_15`、`OMG_Groove`、`Regular_Jump`、`Stand_and_Chat`、`Talk_with_Hands_Open` 等片段；以文件实际清单为准。游戏模式不接受 jump。

## 测试与限制

`tests/split-models.test.ts` 读取真实两份 GLB，检查骨骼数量、两轮顺序循环、播放中不提前结束、取消后重播、切模式互斥、回聊天归零、游戏转向/跑步骨骼采样及根位置隔离。Node 测试跳过纹理解码，浏览器测试等待两套资源加载，覆盖技能、模式切换和手机布局。

当前资源没有表情变形目标，已有命名头部骨骼仅能做简单表现。原有眼罩按命名节点切换，无法因切换文件自动生成缺失配件。完整语音、iPhone 真机渲染和性能需后续验收。
