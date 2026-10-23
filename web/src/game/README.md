# 游戏规则引擎

`engine.ts` 导出 `GameEngine` 和所有类型。规则不依赖页面、三维渲染或灵矽。

## 使用

1. 创建 `new GameEngine()`，订阅 `subscribe((snapshot, events) => ...)`。
2. 调用 `start()`，或用毫秒指定苹果寿命，例如 `start(10000)`。
3. 页面动画循环每帧调用 `tick()`，使用默认墙上时钟；不要传入浏览器动画循环的相对时间。
4. 按钮和灵矽工具统一调用 `await requestAction(action, steps)`；只有真正完成、取消或拒绝后才返回结果。
5. `stop()` 立即取消当前及等待动作，但不暂停一分钟计时。

场地使用 `x/z` 坐标，向左为负 `x`，向前为正 `z`（靠近固定镜头）。每步一米、持续 600 毫秒，位置随时间连续推进；转圈持续 1400 毫秒。三次完成的小步或转圈后疲惫五秒，疲惫不禁止移动；正常状态空闲五秒会清零连续计数。执行中加等待队列最多容纳两个请求。快照为副本，事件编号在引擎实例内唯一。

抓取在移动路径首次接触苹果的实际时刻成立，不等到整步完成；补位从实际抓取时刻起算一秒。苹果到期和抓取同刻时，到期优先；到达第 60000 毫秒时，结算优先。补位沿用本局开始时配置的寿命。`start(lifespanMs, deadline)` 可接收更早的绝对截止时间；`end()` 可立即结束本局。`now` 和 `random` 可在测试中注入，测试不需要真实等待。

应用进入后台时应先 `stop()`，它先推进至调用时刻的真实位置再取消动作；恢复时直接 `tick()`。引擎按绝对截止时间结算，不补记后台期间已取消的动作。

## 规则自测

从仓库根目录执行：

```sh
tsc --strict --skipLibCheck --target ES2020 --module commonjs --outDir /private/tmp/niu-game-test web/src/game/game-engine.test.ts
node -e 'require("/private/tmp/niu-game-test/game-engine.test.js").runSelfTest().then(() => console.log("Game engine tests passed"), error => { console.error(error); process.exitCode = 1; })'
```

覆盖开局、路径抓取、补位、过期、边界、疲惫恢复、队列上限、停止、非法配置、结算和重新开局。此测试不替代真实灵矽链路或手机验证。
