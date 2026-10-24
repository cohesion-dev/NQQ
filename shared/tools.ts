/** 游戏工具的唯一动作集合，网页与网关共同验证。 */
export const actions = ['left', 'right', 'forward', 'backward', 'spin', 'somersault', 'dance', 'stop'] as const;

/** 聊天技能只改变角色表现，不创建苹果游戏或改变得分。 */
export const chatSkills = ['spin', 'somersault', 'dance'] as const;
export type ChatSkill = typeof chatSkills[number];

/** 网关和页面共用模式限制，防止聊天技能被当作未开局动作拒绝。 */
export function canPerformAction(mode: 'chat' | 'apple-game', action: unknown): boolean {
  if (mode === 'chat') return action === 'stop' || chatSkills.some((skill) => skill === action);
  return actions.some((name) => name === action) && action !== 'dance';
}

/** 向灵矽报告可用的端侧工具，不提供苹果坐标或自动寻路。 */
export const tools = [
  {
    name: 'self.niuqiqi.start_apple_game',
    description: '当玩家明确说想玩抓苹果时，启动三分钟蒙眼抓苹果游戏。只能在聊天模式调用，不接受参数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'self.niuqiqi.do_action',
    description: '聊天模式允许 spin、somersault 原地翻跟头、dance 原地跳舞和 stop 停止，不需开始游戏。游戏模式允许 left/right/forward/backward 移动、spin、somersault 和 stop。两种模式的 spin 都是围绕身旁中心点走一圈（约4.2秒，结束回到起点并面向前方），游戏中会抓取沿途苹果，触边提前结束。移动会先转向、行走、最后回正；方向按画面判断。工具实际完成后才返回结果。',
    inputSchema: {
      type: 'object', properties: {
        action: { type: 'string', enum: actions },
        steps: { type: 'integer', minimum: 1, maximum: 3, default: 1, description: '移动步数，范围1到3；到达边界后动作提前结束。技能和停止仅为1' },
      }, required: ['action'], additionalProperties: false,
    },
  },
  {
    name: 'self.niuqiqi.exit_apple_game',
    description: '当玩家明确要求退出抓苹果游戏时，结束当前游戏并回到聊天模式。不接受参数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'self.niuqiqi.get_status', description: '查询牛七七的实际得分、剩余时间和疲惫状态；不返回苹果位置。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** 验证模型传来的工具参数，拒绝未知动作和额外字段。 */
export function validTool(name: unknown, args: Record<string, unknown>): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (name === 'self.niuqiqi.start_apple_game' || name === 'self.niuqiqi.exit_apple_game') return Object.keys(args).length === 0;
  if (name === 'self.niuqiqi.get_status') return Object.keys(args).length === 0;
  if (name !== 'self.niuqiqi.do_action' || !actions.includes(args.action as typeof actions[number])) return false;
  if (Object.keys(args).some((key) => !['action', 'steps'].includes(key))) return false;
  const steps = args.steps ?? 1;
  return typeof steps === 'number' && Number.isInteger(steps) && steps >= 1 && steps <= 3
    && (!['spin', 'somersault', 'dance', 'stop'].includes(String(args.action)) || steps === 1);
}
