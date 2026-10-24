import type { ActionName, GameSnapshot } from '../game/engine';

export type MockIntent =
  | { kind: 'action'; action: ActionName; steps?: number }
  | { kind: 'chat'; text: string };

/** 模拟灵矽的意图识别和回复，真实接入时替换为网关适配器。 */
export class MockLinxAdapter {
  /** 将玩家文字解析为动作或普通聊天。 */
  async interpret(text: string): Promise<MockIntent> {
    const value = text.trim();
    const steps = value.match(/(?:([0-9]+)|([一二两三四五六七八九十百]+))步/);
    const parsedSteps = steps ? this.parseSteps(steps[1] ?? steps[2]) : undefined;
    const actionRules: Array<[RegExp, ActionName]> = [
      [/向左|左边|左走/, 'left'],
      [/向右|右边|右走/, 'right'],
      [/向前|前进|往前/, 'forward'],
      [/向后|后退|往后/, 'backward'],
      [/转圈|转一圈|转圈圈/, 'spin'],
      [/停下|停止|别动/, 'stop'],
    ];
    const match = actionRules.find(([pattern]) => pattern.test(value));
    if (match) return { kind: 'action', action: match[1], steps: match[1] === 'spin' || match[1] === 'stop' ? undefined : parsedSteps ?? 1 };
    return { kind: 'chat', text: value };
  }

  /** 生成带有牛七七口吻的本地模拟回复。 */
  async reply(text: string, snapshot: GameSnapshot): Promise<string> {
    const value = text.trim();
    if (/累|疲惫|体力/.test(value)) return snapshot.fatigued ? '嘴还能聊，腿已经下班了。' : '现在精神得很，苹果尽管来！';
    if (/多少|分数|苹果/.test(value)) return `我已经抓到 ${snapshot.score} 个苹果啦！`;
    if (/你是谁|名字/.test(value)) return '我是牛七七，蒙着眼也能听你的指挥。';
    return value ? `我听见啦：${value}。你可以指挥我去抓苹果。` : '我在等你的指挥～';
  }

  /** 解析中文或阿拉伯数字步数。 */
  private parseSteps(value: string): number {
    const map: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (/^\d+$/.test(value)) return Math.max(1, Number(value));
    if (value === '十') return 10;
    const tenIndex = value.indexOf('十');
    if (tenIndex >= 0) {
      const tens = tenIndex === 0 ? 1 : map[value[tenIndex - 1]] ?? 1;
      const ones = map[value[tenIndex + 1]] ?? 0;
      return tens * 10 + ones;
    }
    return Math.max(1, map[value] ?? 1);
  }
}
