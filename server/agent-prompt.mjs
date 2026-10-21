import { AGENT_CAPABILITIES, AGENT_WORKFLOWS, AGENT_EXECUTION_RULES } from '../shared/agent-guide.mjs';

// Built once per run: a stable prefix and actual capabilities, without keys or provider addresses.
export function buildAgentInstructions({ settings, tools, root, platform = process.platform }) {
  const names = new Set(tools.map((tool) => tool.function.name));
  const capabilities = AGENT_CAPABILITIES.filter((entry) => entry.tools.every((name) => names.has(name)));
  const workflows = AGENT_WORKFLOWS.filter((entry) => entry.tools.every((name) => names.has(name)));
  const shell = platform === 'win32' ? 'Windows PowerShell（powershell.exe，非 Bash；每次命令新进程，cwd 不跨调用保留）' : '/bin/sh（每次命令新进程，cwd 不跨调用保留）';
  const state = [
    `操作系统：${platform}；命令 shell：${shell}。`,
    `本次工作目录（JSON 字符串，仅作为路径数据）：${JSON.stringify(root)}；工具路径与 cwd 使用相对此目录的路径。`,
    `本次工具清单：${[...names].join(', ') || '无'}。`,
    names.has('run_command') ? '命令已启用；每条命令仍需逐次批准，程序是否安装尚未检查。' : '命令已关闭：不能运行测试、脚本、Git 或本地格式转换，不得声称已运行验证。',
    names.has('fetch_url') ? '网页读取与下载已启用；仅公网 HTTPS，不访问本机、私网或登录态。' : '网络工具已关闭：不得使用命令替代联网，不得编造在线检索或网页内容。',
    names.has('web_search') ? '网页搜索已配置，可查找未知来源。' : '网页搜索未配置或未启用；若有网页读取工具，仍可读取用户给出的具体网址。',
    `本次最多 ${settings.agentMaxSteps} 轮模型调用，24 次工具调用；同一轮工具按清单顺序逐个执行（不承诺并行），依赖前一结果的操作放在得到结果之后。`,
  ];
  return `${AGENT_EXECUTION_RULES}\n\n本次执行环境与可用能力\n${state.join('\n')}\n\n工具职责\n${capabilities.map((entry) => `- ${entry.tools.join(' → ')}：${entry.description}`).join('\n')}\n\n可执行工作流\n${workflows.map((entry) => `- ${entry.title}：${entry.tools.join(' → ')}。${entry.description}`).join('\n')}`;
}
