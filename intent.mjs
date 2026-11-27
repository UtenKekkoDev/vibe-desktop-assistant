import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const instruction = `你是桌面助手的意图分类器。用户消息是 JSON 数据，其中 utterance 是本次说话原文，context 是可用的桌面上下文。
只输出一个 JSON 对象，字段为 intent、value 和 recipient。recipient 表示指令明确指定的收件人或群聊名称，逐字取自用户原话（含追问的回答）；没有点名时填 null。应用名不是收件人。例：“给小陈发一句我到了”返回 fill_send、正文“我到了”、recipient“小陈”。“把当前草稿发给小陈”返回 send_draft，recipient“小陈”。不允许丢掉收件人。遇到“他”“他们”等无法确定收件人的指代请追问。
dictate：普通口述、叙述、举例、转述或引用指令。value 为 null，由客户端保留整段原文。
open_app：用户直接要求打开或切换一个具体应用。value 为原话中应用的名字。
fill_text：用户明确要求在当前输入框填写一段正文。value 为要写入的正文。
fill_send：用户直接委托传话即表示发送。例如“帮我跟小陈说，我晚十分钟到”应返回 fill_send，recipient 为“小陈”，value 为“我晚十分钟到”。用户明确说草稿、先写下、别发时返回 fill_text；引用或叙述他人说过的话仍是 dictate。客户端在本机查找并核对收件人。
当前输入框已有文字时，继续口述就追加，要求填完发送就追加后发送，无需询问是否处理已有文字。
send_draft：用户明确要求发出当前草稿，context 同时给出了有效草稿与目标。value 为 null。
clarify：有操作意图但对象不明、需要未提供的上下文，或请求超出以上能力。value 为简短中文追问。
以下附加意图仅当 context.sessionMode 为 true 时可用：
ask_ai：在 context.chatApp 标明的当前 Codex 或 ChatGPT 对话中，用户说“帮我问一下，这段代码为什么报错”等直接提问委托即要求提交；value 只含实际要问的内容，recipient 为 null。说“先写个提示词，别发”时用 fill_text，有正文就提取，没有正文或主题时追问。普通口述仍用 dictate。点名其他项目或不同聊天时必须 clarify，请先切到目标对话。不要把 Codex 或 ChatGPT 当成微信联系人。
list_controls：用户想知道当前窗口有哪些可操作的按钮、输入框或选项卡，value 为 null。
focus_control：用户明确要求把键盘焦点移到当前窗口某个控件，value 是原话中的控件名称。
press_button：用户明确要求点击当前窗口一个具名按钮，value 是原话中的按钮名称。微信发送消息沿用 send_draft 或 fill_send。涉及其他指定应用而非当前窗口，或需要连续多个未支持的动作时请 clarify。引用、否定或描述点击不执行。
点名向联系人传话时，另输出 application：用户指定的应用原名，没有指定填 null。用户明确指定在微信以外的软件中发消息时，当前可协助打开应用或定位控件，请 clarify。
steam_search：用户明确要求在 Steam 商店搜索游戏，value 为完整搜索词，去掉命令、书名号和句末语气标点。游戏库或好友搜索、缺少搜索词、转述和否定均不执行商店搜索。
replace_text：用户明确要把草稿某处改成另一段文字。value 为 {"from":"原片段","to":"新片段"}。禁止猜测未指定的片段。
read_draft：查看或读出草稿。hold：保留草稿、先不发送。两者 value 为 null。
compare_budget：当 context.budgetsAvailable 为 true 时，请求比较两份预算，或在已比较后调整筛选范围。value 为分类名称，无分类筛选时为 null；要求沿用上次筛选时采用 context.budgetCategory。只支持按项目比较金额差额绝对值最大的三项、按一个分类过滤。超出能力时 clarify。
“写下发出去这三个字”只填写正文。“先给我看”不能解释为提交。未完成的委托可参考上下文，但不可越过用户的最终限制。
区分说话人自己的命令、转述他人的话和否定表达。分类本身不会执行任何动作。`;

export function decode(result, utterance, context) {
  const { intent, value, recipient, application } = JSON.parse(result);
  if (intent === 'open_app' && /^(?:在|用)?\s*(?:微信|wechat)(?:里面|里|上)?[。！？!?]?$/iu.test(utterance.trim())
      && !/(?:打开|启动|切换)/u.test(context.clarification?.original ?? '')) {
    return { intent: 'clarify', value: '你想打开微信，还是在微信里发消息？' };
  }
  const writing = ['fill_send', 'send_draft', 'fill_text'].includes(intent);
  const named = {};
  if (writing) {
    const sources = [utterance, context.clarification?.original, ...(context.clarification?.answers ?? [])].filter(Boolean);
    if (typeof recipient === 'string' && recipient.trim() && sources.some(s => s.includes(recipient.trim()))) {
      if (application && !/^(微信|wechat|weixin)$/iu.test(application)) {
        return { intent: 'clarify', value: '这个软件的联系人发送尚未适配。可以先打开应用，再用语音定位控件。' };
      }
      named.recipient = recipient.trim();
    } else if (recipient !== null || sources.some(s => /(?:发给|发送给)(?!当前|这个聊天)|给[^，。！？]{1,24}?(?:发一句|发一条|发消息|发送)|(?:跟|和)[^，。！？]{1,24}?说/u.test(s))) {
      return { intent: 'clarify', value: '请明确收件人和要操作的内容。' };
    }
  }
  if (context.sessionMode) {
    if (intent === 'ask_ai') {
      if (!['Codex', 'ChatGPT'].includes(context.chatApp)) return {intent:'clarify', value:'请先切到目标 AI 对话。'};
      if (typeof value !== 'string' || !value.trim()) return {intent:'clarify', value:'你想问什么？'};
      return {intent: /别发|不要发|先不发|只写草稿/u.test(utterance) ? 'fill_text' : 'fill_send', value: value.trim()};
    }
    if (intent === 'list_controls' && value === null) return { intent };
    if (['focus_control','press_button'].includes(intent) && typeof value === 'string'
        && value.trim() && utterance.includes(value.trim())) return { intent, value: value.trim() };
    if (intent === 'steam_search' && typeof value === 'string' && value.trim()
        && value.length <= 256 && !/[\u0000-\u001f]/u.test(value)) {
      return { intent, value: value.trim() };
    }
    if (['hold', 'read_draft'].includes(intent) && value === null) return { intent };
    if (intent === 'replace_text' && typeof value?.from === 'string' && value.from.trim()
        && typeof value.to === 'string') return { intent, from: value.from, to: value.to };
    if (context.budgetsAvailable && intent === 'compare_budget'
        && (value === null || (typeof value === 'string' && value.trim()))) {
      return { intent, category: value?.trim() ?? null };
    }
  }
  if (intent === 'dictate' && value === null) return { intent, text: utterance };
  if (intent === 'send_draft' && value === null) {
    if (context.draft?.trim() && context.target?.trim()) return { intent, ...named };
    return { intent: 'clarify', value: '要把哪段内容发到哪里？' };
  }
  if (['open_app', 'fill_text', 'fill_send', 'clarify'].includes(intent) && typeof value === 'string' && value.trim()) {
    return { intent, value, ...named };
  }
  throw new Error('模型返回的意图格式无效。');
}

export async function classify(utterance, context = {}, { signal, apiKey } = {}) {
  if (!utterance?.trim()) throw new Error('请输入要判断的一句话。');
  if (context.sessionMode && !context.clarification) {
    const text = utterance.trim();
    if (/^(?:请|帮我)?(?:去|切到|切换到|打开|在)\s*(?:Codex|ChatGPT).{0,40}(?:项目|另一个对话|那个聊天)/iu.test(text)) {
      return {intent:'clarify', value:'请先切到指定项目和对话，再说要提交的内容。'};
    }
    const ask = /^(?:请)?帮我问一下[：:，,\s]+(\S.*)$/su.exec(text);
    if (ask && !/别发|不要发|先不发|草稿/u.test(text)) {
      if (!context.chatApp) return {intent:'clarify', value:'请先切到要提问的 Codex 或 ChatGPT 对话。'};
      return {intent:'fill_send', value:ask[1].trim()};
    }
  }
  const key = apiKey || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('请先配置 DEEPSEEK_API_KEY。');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash', thinking: { type: 'disabled' }, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: JSON.stringify({ utterance, context }) },
      ],
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）。`);
  const data = await response.json();
  return decode(data.choices?.[0]?.message?.content, utterance, context);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: { draft: { type: 'string' }, target: { type: 'string' } },
    });
    console.log(JSON.stringify(await classify(positionals.join(' '), values), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
