/** 游戏工具的唯一动作集合，网页与网关共同验证。 */
export const actions = ['left', 'right', 'forward', 'backward', 'spin', 'stop'] as const;

/** 向灵矽报告可用的端侧工具，不提供苹果坐标或自动寻路。 */
export const tools = [
  {
    name: 'self.niuqiqi.do_action',
    description: '指挥蒙眼牛七七动作。left/right 是画面左右，forward 靠近镜头，backward 远离镜头，spin 原地转圈，stop 立即停止。一小步约600毫秒；工具实际完成后才返回结果。',
    inputSchema: {
      type: 'object', properties: {
        action: { type: 'string', enum: actions },
        steps: { type: 'integer', minimum: 1, maximum: 3, default: 1, description: '移动步数，转圈和停止仅为1' },
      }, required: ['action'], additionalProperties: false,
    },
  },
  {
    name: 'self.niuqiqi.get_status', description: '查询牛七七的实际得分、剩余时间和疲惫状态；不返回苹果位置。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** 验证模型传来的工具参数，拒绝未知动作和额外字段。 */
export function validTool(name: unknown, args: Record<string, unknown>): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (name === 'self.niuqiqi.get_status') return Object.keys(args).length === 0;
  if (name !== 'self.niuqiqi.do_action' || !actions.includes(args.action as typeof actions[number])) return false;
  if (Object.keys(args).some((key) => !['action', 'steps'].includes(key))) return false;
  const steps = args.steps ?? 1;
  return typeof steps === 'number' && Number.isInteger(steps) && steps >= 1 && steps <= 3
    && (!['spin', 'stop'].includes(String(args.action)) || steps === 1);
}
