import { randomUUID } from 'node:crypto';
import { createAgentTools } from './agent-tools.mjs';
import { normalizeUsage } from '../shared/provider.mjs';
import { buildAgentInstructions } from './agent-prompt.mjs';

const ENCODER=new TextEncoder();
const MAX_COMPLETION=2*1024*1024;

export class AgentError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
const cancelled=()=>new DOMException('Agent 已停止。','AbortError');
const isId=(value)=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const detail=(value)=>{
  const text=typeof value==='string'?value:JSON.stringify(value,null,2);
  return text.length<=12000?text:`${text.slice(0,11950)}\n… 输出已截短；完整结果已交给模型。`;
};

async function limitedText(response,signal){
  const reader=response.body?.getReader();
  if(!reader)throw new AgentError(502,'模型没有返回内容。');
  const chunks=[];let length=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  try{
    while(true){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;length+=value.byteLength;
      if(length>MAX_COMPLETION)throw new AgentError(502,'Agent 模型单轮响应超过 2 MiB 上限。');chunks.push(value);}
    signal?.throwIfAborted();
    return Buffer.concat(chunks).toString('utf8');
  }finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** The engine boundary: compatible models return text and typed tool calls only. */
export async function readAgentCompletion(response,signal){
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new AgentError(502,`Agent 模型请求失败（HTTP ${response.status}）。请确认模型支持工具调用，或改用直接聊天。`);}
  const text=await limitedText(response,signal);
  let payload;
  if((response.headers.get('content-type')||'').includes('text/event-stream')){
    let content='',usage=null;const calls=new Map();
    for(const block of text.split(/\r?\n\r?\n/)){
      const data=block.split(/\r?\n/).filter((line)=>line.startsWith('data:')).map((line)=>line.slice(5).trimStart()).join('\n');
      if(data.trim()==='[DONE]')break;
      if(!data)continue;
      let event;try{event=JSON.parse(data);}catch{throw new AgentError(502,'Agent 模型返回了损坏的事件。');}
      if(event.error)throw new AgentError(502,'Agent 模型报告错误。');
      usage=normalizeUsage(event)||usage;
      const delta=event.choices?.[0]?.delta;
      if(typeof delta?.content==='string')content+=delta.content;
      for(const part of delta?.tool_calls||[]){
        if(!Number.isSafeInteger(part.index)||part.index<0||part.index>7)throw new AgentError(502,'Agent 工具调用序号无效。');
        const call=calls.get(part.index)||{id:'',type:'function',function:{name:'',arguments:''}};
        if(part.id)call.id+=part.id;
        if(part.function?.name)call.function.name+=part.function.name;
        if(typeof part.function?.arguments==='string')call.function.arguments+=part.function.arguments;
        calls.set(part.index,call);
      }
    }
    payload={choices:[{message:{role:'assistant',content,tool_calls:[...calls.entries()].sort(([a],[b])=>a-b).map(([,call])=>call)}}],usage};
  }else{try{payload=JSON.parse(text);}catch{throw new AgentError(502,'Agent 模型没有返回有效的 JSON。');}}
  const message=payload?.choices?.[0]?.message;
  if(payload?.error||!message||message.content!=null&&typeof message.content!=='string')throw new AgentError(502,'模型未返回兼容的 Agent 回答。');
  if(message.tool_calls!==undefined&&!Array.isArray(message.tool_calls))throw new AgentError(502,'模型返回的工具调用格式无效。');
  const calls=message.tool_calls||[];
  if(calls.length>8)throw new AgentError(502,'模型单轮请求了过多工具。');
  const ids=new Set();
  const toolCalls=calls.map((call,index)=>{
    const id=call.id||`call_${randomUUID()}`;
    if(!isId(id)||ids.has(id)||call.type&&call.type!=='function'||typeof call.function?.name!=='string')throw new AgentError(502,'模型返回了重复或无效的工具调用。');
    ids.add(id);let args;
    try{args=typeof call.function.arguments==='string'?JSON.parse(call.function.arguments):call.function.arguments;}catch{throw new AgentError(502,'模型工具参数不是有效 JSON；尚未执行这一轮的任何工具。');}
    if(!args||typeof args!=='object'||Array.isArray(args))throw new AgentError(502,'模型工具参数必须为对象。');
    return {id,type:'function',function:{name:call.function.name,arguments:JSON.stringify(args)},args};
  });
  const content=message.content||'';
  if(!content.trim()&&!toolCalls.length)throw new AgentError(502,'Agent 模型返回空回答。');
  return {content,toolCalls,usage:normalizeUsage(payload)};
}

export async function compatibleAgentTurn({settings,messages,tools,signal,fetchImpl}){
  const timeout=AbortSignal.timeout(settings.requestTimeoutSeconds*1000);
  const combined=AbortSignal.any([signal,timeout]);
  let response;
  try{
    response=await fetchImpl(`${settings.baseUrl}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',...(settings.apiKey?{Authorization:`Bearer ${settings.apiKey}`}:{})},
      body:JSON.stringify({model:settings.model,messages,temperature:settings.temperature,stream:false,tools,tool_choice:'auto',...(settings.maxOutputTokens>0?{max_tokens:settings.maxOutputTokens}:{})}),signal:combined});
    return await readAgentCompletion(response,combined);
  }catch(error){
    if(signal.aborted)throw cancelled();
    if(timeout.aborted)throw new AgentError(504,'Agent 模型请求超时；已经完成的操作保留。');
    if(error instanceof AgentError)throw error;
    throw new AgentError(502,'无法连接 Agent 模型。检查模型服务是否支持工具调用；直接聊天仍可单独使用。');
  }
}

/** Owns ephemeral runs/approvals. Durable transcript data remains in the workspace. */
export function createAgentRuntime({getSettings,available=false,fetchImpl=globalThis.fetch,toolFactory=createAgentTools,engines={compatible:compatibleAgentTurn}}){
  const runs=new Map();let closed=false;
  const requireEnabled=()=>{
    const settings={...getSettings()};
    if(!available)throw new AgentError(403,'本地 Agent 执行只在桌面应用中提供。');
    if(!settings.agentEnabled)throw new AgentError(403,'请先在设置中开启可选 Agent。');
    if(!settings.agentWorkspace)throw new AgentError(400,'请先选择 Agent 工作目录。');
    if(!engines[settings.agentEngine])throw new AgentError(400,'当前 Agent 执行引擎不可用。');
    return settings;
  };
  return {
    capabilities(){const settings=getSettings();return {available,enabled:available&&settings.agentEnabled,engine:settings.agentEngine,configured:Boolean(settings.agentWorkspace),activeRunIds:[...runs.keys()]};},
    async start(input,requestSignal){
      if(closed)throw new AgentError(503,'Agent 后台正在关闭。');
      const settings=requireEnabled();
      if(runs.size)throw new AgentError(409,'已有 Agent 正在执行，请先停止或等待完成。');
      if(!isId(input.runId)||!Array.isArray(input.messages)||!input.messages.length)throw new AgentError(400,'Agent 请求缺少运行 ID 或消息。');
      const controller=new AbortController();
      const run={id:input.runId,controller,pending:new Map(),done:null,stream:null,output:0,steps:0};
      runs.set(run.id,run);
      const stop=()=>{controller.abort();for(const wait of run.pending.values())wait.reject(cancelled());run.pending.clear();};
      run.stop=stop;
      requestSignal?.addEventListener('abort',stop,{once:true});
      if(requestSignal?.aborted)stop();
      const emit=(name,payload)=>{
        if(!run.stream)return;
        try{run.stream.enqueue(ENCODER.encode(`event: ${name}\ndata: ${payload==='[DONE]'?'[DONE]':JSON.stringify(payload)}\n\n`));}catch{run.stream=null;stop();}
      };
      const event=(type,extra={})=>emit('agent',{type,runId:run.id,at:new Date().toISOString(),...extra});
      const approve=(call,prepared)=>new Promise((resolve,reject)=>{
        if(controller.signal.aborted){reject(cancelled());return;}
        const timer=setTimeout(()=>{run.pending.delete(call.id);reject(new AgentError(408,'等待确认超时，Agent 已停止。'));},15*60*1000);
        const settle=(fn,value)=>{clearTimeout(timer);run.pending.delete(call.id);fn(value);};
        run.pending.set(call.id,{resolve:(value)=>settle(resolve,value),reject:(error)=>settle(reject,error)});
        event('approval.required',{callId:call.id,tool:call.function.name,summary:prepared.summary,preview:prepared.preview});
      });
      const execute=async()=>{
        let status='failed';
        try{
          const host=await toolFactory({root:settings.agentWorkspace,allowCommands:settings.agentAllowCommands,allowNetwork:settings.agentAllowNetwork,searchEndpoint:settings.agentSearchEndpoint,fetchImpl});
          controller.signal.throwIfAborted();
          const tools=host.tools;
          const allowed=new Set(tools.map((tool)=>tool.function.name));
          const messages=[{role:'system',content:buildAgentInstructions({settings,tools,root:host.root})},...(settings.systemPrompt?[{role:'system',content:settings.systemPrompt}]:[]),...input.messages.map(({role,content})=>({role,content}))];
          event('run.started',{engine:settings.agentEngine,workspace:host.root});
          const executed=new Set();let calls=0;let usage=null,allUsage=true,knownCache=true;
          for(let step=0;step<settings.agentMaxSteps;step++){
            controller.signal.throwIfAborted();run.steps=step+1;
            event('model.started',{step:run.steps});
            const turn=await engines[settings.agentEngine]({settings,messages,tools,signal:controller.signal,fetchImpl});
            controller.signal.throwIfAborted();
            if(turn.usage){usage={inputTokens:(usage?.inputTokens||0)+turn.usage.inputTokens,outputTokens:(usage?.outputTokens||0)+turn.usage.outputTokens,cachedInputTokens:(usage?.cachedInputTokens||0)+(turn.usage.cachedInputTokens||0)};if(turn.usage.cachedInputTokens===null)knownCache=false;}else allUsage=false;
            if(turn.content){
              const text=(run.output?'\n\n':'')+turn.content;
              if(run.output+text.length>100000)throw new AgentError(413,'Agent 回答达到长度上限；已完成的操作保留。');
              run.output+=text.length;emit('message',{choices:[{delta:{content:text}}]});
            }
            if(!turn.toolCalls.length){if(usage&&allUsage)emit('message',{choices:[],usage:{...usage,cachedInputTokens:knownCache?usage.cachedInputTokens:null}});status='completed';break;}
            if(calls+turn.toolCalls.length>24)throw new AgentError(400,'Agent 已达到 24 次工具调用上限；已完成的操作保留。');
            if(turn.toolCalls.some((call)=>!allowed.has(call.function.name)||executed.has(call.id)))throw new AgentError(502,'模型请求了不可用或重复的工具调用；这一轮尚未执行。');
            messages.push({role:'assistant',content:turn.content||null,tool_calls:turn.toolCalls.map(({args,...call})=>call)});
            for(const call of turn.toolCalls){
              controller.signal.throwIfAborted();executed.add(call.id);calls++;
              const tool=call.function.name;
              let prepared,result;
              try{
                prepared=await host.prepare(tool,call.args,{signal:controller.signal});
                if(prepared.requiresApproval&&!await approve(call,prepared)){
                  result={error:'用户拒绝了这次操作。不得通过其他工具绕过该决定。'};event('tool.denied',{callId:call.id,tool,summary:prepared.summary,detail:result.error});
                }else{
                  controller.signal.throwIfAborted();
                  event('tool.started',{callId:call.id,tool,summary:prepared.summary,detail:detail(prepared.preview)});
                  result=await prepared.execute();
                  controller.signal.throwIfAborted();
                  const failedCommand=tool==='run_command'&&(result?.timedOut||result?.exitCode!==0);
                  event(failedCommand?'tool.failed':'tool.completed',{callId:call.id,tool,summary:prepared.summary,detail:detail(result)});
                  if(['write_file','edit_file','download_file'].includes(tool)&&typeof prepared.preview.path==='string')event('artifact',{path:prepared.preview.path,kind:tool==='download_file'?'download':'file',summary:prepared.summary});
                }
              }catch(error){
                if(controller.signal.aborted||error.name==='AbortError'){event('tool.cancelled',{callId:call.id,tool,summary:prepared?.summary||tool,detail:'该操作已停止。已完成的文件修改不会自动撤销。'});throw cancelled();}
                result={error:String(error.message||'工具执行失败。').slice(0,2000)};
                event('tool.failed',{callId:call.id,tool,summary:prepared?.summary||tool,detail:result.error});
              }
              messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
            }
          }
          if(status!=='completed')throw new AgentError(400,'Agent 达到本次步数上限；执行记录和已完成的操作保留。');
        }catch(error){
          status=controller.signal.aborted||error.name==='AbortError'?'cancelled':'failed';
          event('run.finished',{status,steps:run.steps,error:status==='failed'?error.message:undefined});
          if(status==='failed')emit('error',{error:error.message||'Agent 执行失败。'});
        }finally{
          if(status==='completed')event('run.finished',{status,steps:run.steps});
          for(const wait of run.pending.values())wait.reject(cancelled());run.pending.clear();
          requestSignal?.removeEventListener('abort',stop);
          emit('message','[DONE]');
          try{run.stream?.close();}catch{}
          run.stream=null;runs.delete(run.id);
        }
      };
      const body=new ReadableStream({start(output){run.stream=output;},async cancel(){run.stream=null;stop();await run.done;}});
      // Start after installing the stream and before returning its Response.
      run.done=execute();
      return new Response(body,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    },
    approve({runId,callId,approved}){
      if(typeof approved!=='boolean'||!isId(runId)||!isId(callId))throw new AgentError(400,'Agent 确认参数无效。');
      const wait=runs.get(runId)?.pending.get(callId);
      if(!wait)throw new AgentError(409,'该操作已结束、过期或尚未请求确认。');
      wait.resolve(approved);return {ok:true};
    },
    async cancel({runId}){const run=runs.get(runId);if(run){run.stop();await run.done;}return {ok:true};},
    async close(){closed=true;for(const run of runs.values())run.stop();await Promise.all([...runs.values()].map((run)=>run.done));},
    get active(){return runs.size>0;},
  };
}
