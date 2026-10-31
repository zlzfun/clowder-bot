import type { AgentProvider, AgentRequest, AgentEvent } from '../../shared/types.js';

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('已停止'));
    const abort = () => { clearTimeout(timer); reject(new Error('已停止')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Deterministic local walkthrough, deliberately labelled; never an imitation model. */
export class DemoProvider implements AgentProvider {
  async *stream(request: AgentRequest): AsyncIterable<AgentEvent> {
    const { bot, messages, signal } = request;
    const last = messages.findLast(m => m.role === 'user')?.content ?? '';
    const system = messages[0]?.content ?? '';
    const rosterBlock = system.split('群成员：\n')[1]?.split('\n\n')[0] ?? '';
    const roster = Array.from(rosterBlock.matchAll(/^- (.+)$/gm), m => m[1]!);
    const other = roster.filter(name => name !== bot.name);
    const handoff = last.startsWith('协作交接任务：');
    const memoryRequest = last.match(/(?:请)?记住[：:,，\s]*(.+)/s)?.[1]?.trim();
    let text = '';
    if (memoryRequest && !handoff) {
      const safe = memoryRequest.replace(/<\/?memory[^>]*>/g, '').slice(0, 1000);
      text = `记下了：**${safe}**\n\n这条内容会保存到共享记忆，其他猫猫也可以参考。\n\n_演示回复 · 本地脚本生成_\n<memory scope="shared">${safe}</memory>`;
    } else if (/记忆|记得|偏好/.test(last) && !handoff) {
      const memory = messages.find(m => m.content.includes('相关长期记忆：'))?.content.split('相关长期记忆：')[1];
      text = memory ? `我能参考的记忆有：\n${memory}\n\n_演示回复 · 本地脚本生成_` : '还没有相关记忆。可以说「记住：我喜欢简洁的回答」，也可以在记忆页手动添加。\n\n_演示回复 · 本地脚本生成_';
    } else if (handoff) {
      text = bot.templateId === 'maine-coon' ? '收到传球。我会从三个角度检查这个方案：\n\n- **边界**：目标是否明确，异常情况是否覆盖。\n- **证据**：结论是否有可验证的依据。\n- **落地**：先完成最小可用版本，再逐步完善。\n\n本次协作演示完成，下一步可以继续补充你的想法。\n\n_演示回复 · 未执行实际审查或外部操作_' : '收到，我来补充另一个视角。\n\n把关键目标放在最显眼的位置，让第一步足够简单，再用清楚的反馈告诉用户正在发生什么。先做一个可以体验的小版本，通常比一次加入很多功能更有效。\n\n_演示回复 · 本地脚本生成_';
    } else {
      const excerpt = last.replace(/^\[用户\]\s*/, '').slice(0, 120);
      text = `收到，我们一起看看「${excerpt}」。\n\n` + (bot.templateId === 'siamese' ? '我会先从体验出发：\n\n1. 找到用户最想完成的一件事。\n2. 把它变成清楚、顺手的交互。\n3. 用统一的视觉细节让整个体验更舒服。' : bot.templateId === 'maine-coon' ? '我会先确认目标和约束，再检查方案的边界情况。可验证的结果，比听起来完整的承诺更有价值。' : '我的建议是先分成三个步骤：\n\n1. **明确目标**：确认要解决的问题和完成标准。\n2. **做小闭环**：先让核心流程可以实际使用。\n3. **交叉检查**：让不同专长的伙伴补充意见。');
      text += '\n\n_演示回复 · 接入真实模型后，猫猫会根据你的问题进行推理与协作_';
      if (other.length && /一起|协作|讨论|方案|设计|帮我|规划|计划|review|审查|群聊|传球/i.test(last)) {
        text += `\n\n@${other[0]} 请从你的专长出发检查上面的想法，并给出一个具体建议。`;
      }
    }
    for (let i = 0; i < text.length; i += 9) {
      await pause(Number(process.env.CLOWDER_DEMO_DELAY ?? 22), signal);
      yield { type: 'delta', text: text.slice(i, i + 9) };
    }
  }
}
