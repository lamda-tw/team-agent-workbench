"""Build an offline, self-contained task-oriented HTML manual from Markdown."""
from pathlib import Path
import re, json, html, base64, subprocess, argparse, sys
from urllib.parse import unquote
from manual_meta import RELATED, read_meta as read_source_meta
from dataclasses import replace
from datetime import datetime
from functools import lru_cache
from handbook_paths import document_paths
from handbook_notes import editorial_notes, render_notes
from handbook_screenshots import screenshot_caption

ROOT=Path(__file__).resolve().parents[1]
@lru_cache(maxsize=1)
def read_meta():
 commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
 version=json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version']
 return replace(read_source_meta(),commit=commit,software_version=version,date=datetime.now().strftime('%Y 年 %m 月 %d 日'))
DOCS=ROOT/'docs'
WEB=DOCS/'handbook'
STRUCTURE=json.loads((WEB/'structure.json').read_text(encoding='utf-8'))
DISPLAY_TITLES=STRUCTURE['titles']
DESTINATION_TITLES={}
EGRESS_PATH_TITLE='通过管理端访问模型服务的路径'
RELATED_FRAGMENT_TARGETS={}
PAGE_ORDER=[page for group in STRUCTURE['groups'] for page in group['pages']]
if len(PAGE_ORDER)!=len(set(PAGE_ORDER)):
 raise ValueError('Duplicate page in handbook structure')
GROUPS={page:group['title'] for group in STRUCTURE['groups'] for page in group['pages']}
def plain(value):
 value=re.sub(r'!?\[([^\]]*)\]\([^)]+\)',r'\1',value)
 return re.sub(r'[*`#]','',value).strip()

def destination(target):
 filename,_,fragment=target.partition('#')
 if filename in RELATED:
  if fragment:
   key=(filename,unquote(fragment))
   if key not in RELATED_FRAGMENT_TARGETS: raise ValueError(f'Unknown reference heading: {target}')
   return '#'+RELATED_FRAGMENT_TARGETS[key]
  return '#'+RELATED[filename][0]
 if target.startswith(('#','http://','https://')): return target
 return read_meta().repository_url+'docs/'+target

def inline(text):
 result=[]
 for token in re.split(r'(\*\*.*?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))',text):
  m=re.fullmatch(r'\[([^\]]+)\]\(([^)]+)\)',token)
  if m:
   url=destination(m[2]); ext=' target="_blank" rel="noopener noreferrer"' if url.startswith('http') else ''
   label=DESTINATION_TITLES.get(url[1:],m[1]) if url.startswith('#') else m[1]
   result.append(f'<a href="{html.escape(url,quote=True)}"{ext}>{html.escape(label)}</a>')
  elif token.startswith('**'): result.append('<strong>'+html.escape(token[2:-2])+'</strong>')
  elif token.startswith('`'): result.append('<code>'+html.escape(token[1:-1])+'</code>')
  else: result.append(html.escape(token))
 return ''.join(result)

def scenario_inline(text):
 # Chapter references are links; quotes around actual interface labels remain.
 for target in PAGE_ORDER:
  title=DESTINATION_TITLES.get(target)
  if title:
   text=re.sub(r'(继续阅读|阅读|参考|按|见)“'+re.escape(title)+'”',lambda match:match[1]+'['+title+'](#'+target+')',text)
 return inline(text)

def list_item(raw):
 match=re.match(r'^(\s*)(\d+\.|[-*])\s+(.+)$',raw)
 if not match: return None
 marker=match[2]
 return {'indent':len(match[1].expandtabs(4)),'ordered':marker[0].isdigit(),
         'start':int(marker[:-1]) if marker[0].isdigit() else None,'text':match[3]}

def render_list_block(rows):
 def nested(position,indent):
  ordered=rows[position]['ordered'];tag='ol' if ordered else 'ul'
  start=f' start="{rows[position]["start"]}"' if ordered and rows[position]['start']!=1 else ''
  parts=[]
  while position<len(rows) and rows[position]['indent']==indent and rows[position]['ordered']==ordered:
   row=rows[position];position+=1;children=[]
   while position<len(rows) and rows[position]['indent']>indent:
    child,position=nested(position,rows[position]['indent']);children.append(child)
   parts.append('<li>'+inline(row['text'])+''.join(children)+'</li>')
  return f'<{tag}{start}>'+''.join(parts)+f'</{tag}>',position
 output=[];position=0
 while position<len(rows):
  part,position=nested(position,rows[position]['indent']);output.append(part)
 return ''.join(output)

def render(lines,prefix=''):
 output=[]; headings=[]; sections=[]; anchor=None; i=0; source=[]; section=None
 def flush_section():
  if section: sections.append({**section,'text':plain('\n'.join(source))})
 while i<len(lines):
  line=lines[i].strip(); i+=1
  if not line or line.startswith('<!--'): continue
  a=re.fullmatch(r'<a id="([^"]+)"></a>',line)
  if a: anchor=a[1]; continue
  if line.startswith('```'):
   code=[]
   while i<len(lines) and not lines[i].startswith('```'): code.append(lines[i]); i+=1
   i+=1; raw='\n'.join(code)
   output.append('<div class="code-block"><button type="button" class="copy-code">复制</button><pre><code>'+html.escape(raw)+'</code></pre></div>'); source.append(raw); continue
  heading=re.match(r'^(#{2,4}) (.+)$',line)
  if heading:
   flush_section(); source=[]
   title=re.sub(r'^\d+\.\d+\s+','',heading[2])
   identifier=anchor or prefix+'topic-'+str(len(headings)+1); anchor=None
   title=DISPLAY_TITLES.get(identifier,title)
   level='h3' if prefix and len(heading[1])>=3 else 'h2'
   headings.append({'id':identifier,'title':title,'level':level})
   output.append(f'<{level} id="{html.escape(identifier)}" tabindex="-1">{html.escape(title)}<a class="heading-link" href="#{html.escape(identifier)}" aria-label="定位到{html.escape(title)}">#</a></{level}>')
   section={'id':identifier,'title':title}; continue
  img=re.fullmatch(r'!\[([^\]]*)\]\(([^)]+)\)',line)
  if img:
   path=DOCS/img[2]; data=base64.b64encode(path.read_bytes()).decode('ascii')
   caption=screenshot_caption(path.name) if path.parent.name=='ui-screens' else ''
   output.append(f'<figure><button class="zoom-image" type="button" aria-label="放大查看{html.escape(img[1])}"><img src="data:image/png;base64,{data}" alt="{html.escape(img[1])}" loading="lazy"><span>点击放大</span></button>{caption}</figure>'); continue
  if line.startswith('|'):
   rows=[]
   while True:
    cells=[c.strip() for c in line.strip('|').split('|')]
    if not all(re.fullmatch(r':?-+:?',c) for c in cells): rows.append(cells); source.extend(cells)
    if i>=len(lines) or not lines[i].strip().startswith('|'): break
    line=lines[i].strip(); i+=1
   output.append('<div class="table-scroll cols-'+str(len(rows[0]))+'" tabindex="0"><span class="table-hint">左右滑动查看完整表格 →</span><table><thead><tr>'+''.join('<th scope="col">'+inline(c)+'</th>' for c in rows[0])+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+inline(c)+'</td>' for c in row)+'</tr>' for row in rows[1:])+'</tbody></table></div>'); continue
  first_item=list_item(lines[i-1])
  if first_item:
   rows=[first_item]
   while i<len(lines):
    next_item=list_item(lines[i])
    if not next_item: break
    rows.append(next_item);i+=1
   source.extend(row['text'] for row in rows)
   output.append(render_list_block(rows));continue
  if line.startswith('# '): continue
  source.append(line)
  if line.startswith('注：'):
   output.append(render_notes([line[2:]], inline)); continue
  cls=' class="figure-caption"' if re.match(r'^图 \d+ ',line) else ' class="next-actions"' if line.startswith('**接下来可以做') else ''
  output.append(f'<p{cls}>'+inline(line)+'</p>')
 flush_section()
 return ''.join(output),headings,sections

def internal_link(target):
 if target not in DESTINATION_TITLES: raise ValueError(f'Unknown handbook target: {target}')
 return f'<a href="#{html.escape(target,quote=True)}">{html.escape(DESTINATION_TITLES[target])}</a>'

def heading(identifier,title,level='h2'):
 return f'<{level} id="{html.escape(identifier,quote=True)}" tabindex="-1">{html.escape(title)}<a class="heading-link" href="#{html.escape(identifier,quote=True)}" aria-label="定位到{html.escape(title,quote=True)}">#</a></{level}>'

def beta_features_page():
 title='Beta 功能'
 sections=[
  ('beta-open','开启跨会话引用','用户版顶部点击 Beta 功能，开启“跨会话引用”。开关按当前团队账号保存在本机，默认关闭。'),
  ('beta-use','引用另一段会话的摘要','先在来源会话的“AI 参考内容 → 查看阶段摘要”核对或更正摘要。打开同一项目的目标会话，在输入区点击“引用会话摘要”，预览后点击“加入当前会话”。确认参考资料已选中，填写本轮要求并发送。'),
  ('beta-scope','使用范围与共享','只能引用同一团队账号、同一项目在本机保存的其他工作会话。加入摘要后不会立即发送给 AI；发送下一条消息时才会带入。摘要不自动同步给团队，也不作为团队成果上传。引用摘要会关闭目标会话的轨迹自动上传；如需共享轨迹，请先核对并手动上传。'),
  ('beta-close','关闭 Beta 功能','回到顶部“Beta 功能”关闭开关。关闭后隐藏新增引用入口，已加入会话的摘要仍保留；发送前可从输入区参考资料中移除。')]
 sections.extend([
  ('beta-subsession','创建 Subsession','开启“Subsession”后，从工作会话顶部点击“创建 Subsession”，将子任务放入独立会话。子会话的回报经本人查看并选入后，才会发送给父会话的 AI。关闭开关后停止提供新增入口，已有子会话和回报保留。'),
  ('beta-codex-desktop','联动 Codex 桌面版','开启“Codex 桌面联动”，在新建 Codex 会话时勾选“联动 Codex 桌面版”。首次发送会启动或复用后台；需要原生界面时点击“在 Codex 中打开”。两端轮流发送，保留同一会话的上下文。当前支持本机网络；首次启用前，保存工作并退出正在普通方式运行的 Codex。'),
  ('beta-cursor-native','联动 Cursor 原生会话','开启“Cursor 原生联动”，从“接入 Cursor 会话”选择原生会话。保留普通 IDE 窗口；需要返回对应聊天时点击“在 Cursor 中打开”。后续消息等待前一轮结束，模型、模式和权限在两端同步，工具和授权在 Cursor 中处理。独立 Agents 窗口暂不关联。')])
 body='<p class="read-first">从用户版顶部的“Beta 功能”分别开启跨会话引用、Subsession 和桌面联动。开关按当前团队账号保存在本机。</p>'
 body+=''.join(heading(identifier,name)+'<p>'+html.escape(description)+'</p>' for identifier,name,description in sections)
 return {'id':'beta-features','title':title,'group':GROUPS['beta-features'],'html':body,
         'headings':[{'id':identifier,'title':name,'level':'h2'} for identifier,name,_ in sections],
         'sections':[{'id':identifier,'title':name,'text':description} for identifier,name,description in sections],
         'text':' '.join([title,*(description for _,_,description in sections)])}

def questions_page():
 spec=STRUCTURE['questions']
 body='<p class="read-first">'+scenario_inline(spec['intro'])+'</p>'
 headings=[];sections=[]
 for section in spec['sections']:
  body+=heading(section['id'],section['title'])
  body+=''.join('<p>'+scenario_inline(text)+'</p>' for text in section.get('paragraphs',[]))
  if section.get('steps'):
   body+='<ol>'+''.join('<li>'+scenario_inline(text)+'</li>' for text in section['steps'])+'</ol>'
  if section.get('notes'): body+=render_notes(section['notes'],scenario_inline)
  headings.append({'id':section['id'],'title':section['title'],'level':'h2'})
  sections.append({'id':section['id'],'title':section['title'],'text':' '.join(section.get('paragraphs',[])+section.get('steps',[])+section.get('notes',[]))})
 return {'id':spec['id'],'title':spec['title'],'group':GROUPS[spec['id']],'html':body,
         'headings':headings,'sections':sections,'text':spec['intro']+' '+' '.join(s['text'] for s in sections)}

def quickstart_page(spec):
 steps=[]
 for step in spec['steps']:
  badge='<em class="optional-step">可选</em>' if step.get('optional') else ''
  steps.append(f'<li><div>{badge}{internal_link(step["target"])}<span>{html.escape(step["note"])}</span></div></li>')
 body=(f'<p class="home-intro">{html.escape(spec["intro"])}</p>'
       +'<ol class="path-list">'+''.join(steps)+'</ol>'
       +f'<p class="next-actions">{internal_link("start")} · {internal_link("help")}</p>')
 return {'id':spec['id'],'title':spec['title'],'group':GROUPS[spec['id']],
         'html':body,'headings':[],'sections':[],
         'text':spec['intro']+' '+' '.join(DESTINATION_TITLES[s['target']]+' '+s['note'] for s in spec['steps'])}

def enrich_home(article):
 config=STRUCTURE['home']
 cards=[]
 for index,card in enumerate(config['cards'],1):
  target=card['target']
  if target not in DESTINATION_TITLES: raise ValueError(f'Unknown home card target: {target}')
  cards.append(f'<a class="role-card" href="#{html.escape(target,quote=True)}"><span class="role-icon">{index:02d}</span><b>{html.escape(DESTINATION_TITLES[target])}</b><p>{html.escape(card["description"])}</p><span class="go">{html.escape(card["action"])}</span></a>')
 actions=''.join(f'<a class="quick-link" href="#{html.escape(target,quote=True)}">{html.escape(DESTINATION_TITLES[target])}<span aria-hidden="true">→</span></a>' for target in config['common_actions'])
 intro=(f'<p class="home-intro">{html.escape(config["intro"])}</p><div class="role-grid">'
        +''.join(cards)+'</div>'+heading('common-actions','常用操作')
        +f'<div class="quick-grid">{actions}</div>'
        +f'<p class="read-first">软件安装、服务器准备与升级请进入{internal_link(config["deployment_target"])}。个人网络账号无法与模型服务完整交互时，按{internal_link("gateway")}完成配置与验证。</p>'
        +heading('complete-task-index','按任务查找'))
 article['html']=intro+article['html']
 article['headings']=[{'id':'common-actions','title':'常用操作','level':'h2'},
                      {'id':'complete-task-index','title':'按任务查找','level':'h2'}]
 article['sections']=[{'id':'common-actions','title':'常用操作','text':' '.join(DESTINATION_TITLES[target] for target in config['common_actions'])},
                      {'id':'complete-task-index','title':'按任务查找','text':article['text']}]

def enrich_gateway(article):
 path_id='egress-path'; cases_id='egress-scenarios'
 path_title=EGRESS_PATH_TITLE; cases_title='查看接入管理端的操作教程'
 route=[('成员本机','用户版启动 Codex / Cursor / Claude Code CLI'),('连接管理端','直接连接，或经共享服务器 SSH 中转'),
        ('管理端出口','校验证书与接入码，转发模型请求'),('管理端网络','使用具备模型服务访问权限的网络或代理账号'),
        ('模型服务','所选工具的模型服务')]
 flow='<figure class="network-route" aria-label="成员通过管理端网络与模型服务交互"><figcaption>模型请求的网络路径</figcaption><ol>'+''.join(f'<li><b>{html.escape(name)}</b><span>{html.escape(detail)}</span></li>' for name,detail in route)+'</ol><p><strong>经共享服务器中转：</strong>成员连接共享服务器的 SSH 入口，服务器沿管理端预先建立的反向隧道转发请求。成员和管理端都需保持服务器连接。</p><p><strong>团队成果与附件：</strong>成员用户版 → SSH/SFTP → Linux 团队服务器。</p></figure>'
 case_links='<ul>'+''.join(f'<li>{internal_link(case_id)}</li>' for case_id in STRUCTURE['egress_case_ids'])+'</ul>'
 supplement=(heading(path_id,path_title)
             +'<p>总管理员确认管理端具备模型服务访问权限后，开启出口并交付接入码。成员在用户版应用接入码，本次会话通过管理端网络与模型服务交互。</p>'
             +flow
             +'<p>此路径用于工作台启动的 Codex、Cursor 或 Claude Code CLI。成员使用自己的模型账号，模型服务按对应账号和服务规则处理请求。</p>'
             +f'<p class="route-role">操作入口：总管理员看{internal_link("section-14-1")}；项目组管理员和项目组成员看{internal_link("section-14-2")}；部署细节看{internal_link("egress-reference")}。</p>'
             +heading(cases_id,cases_title)
             +'<p>项目组成员 B 的个人网络账号没有与模型服务完整交互的权限。总管理员提供网络通路，B 使用接入码连接管理端并开展 AI 工作。</p>'
             +case_links)
 marker='<h2 id="section-14-1"'
 if marker not in article['html']: raise ValueError('Gateway insertion point changed')
 article['html']=article['html'].replace(marker,supplement+marker,1)
 article['headings']=[{'id':path_id,'title':path_title,'level':'h2'},
                      {'id':cases_id,'title':cases_title,'level':'h2'},*article['headings']]
 article['sections']=[{'id':path_id,'title':path_title,'text':' '.join(name+' '+detail for name,detail in route)+' 团队 SSH/SFTP 通路独立 个人模型账号'},
                      {'id':cases_id,'title':cases_title,'text':' '.join(DESTINATION_TITLES[case_id] for case_id in STRUCTURE['egress_case_ids'])},*article['sections']]
 article['text']+=' '+path_title+' '+cases_title

def case_diagram(spec, identifier=None):
 lanes=[]
 for lane in spec['lanes']:
  nodes=''.join(f'<li>{html.escape(node)}</li>' for node in lane['nodes'])
  lanes.append(f'<div class="case-diagram-lane"><strong>{html.escape(lane["label"])}</strong><ol>{nodes}</ol></div>')
 context=f' data-scenario="{html.escape(identifier,quote=True)}"' if identifier else ''
 return f'<figure class="case-diagram"{context}><figcaption>{html.escape(spec["caption"])}</figcaption>'+''.join(lanes)+'</figure>'

def actor_table(actors):
 rows=''.join(f'<tr><td>{html.escape(actor["name"])}</td><td>{html.escape(actor["role"])}</td></tr>' for actor in actors)
 return '<div class="table-scroll cols-2" tabindex="0"><table><thead><tr><th scope="col">参与者</th><th scope="col">在此场景中的职责</th></tr></thead><tbody>'+rows+'</tbody></table></div>'

def bullet_list(items):
 return '<ul>'+''.join(f'<li>{scenario_inline(item)}</li>' for item in items)+'</ul>'

def comparison_table(spec):
 columns=spec['columns'];rows=spec['rows']
 if any(len(row)!=len(columns) for row in rows): raise ValueError('Comparison table column count differs')
 widths=spec.get('column_widths',[])
 if widths and (len(widths)!=len(columns) or sum(widths)!=100): raise ValueError('Comparison table widths must sum to 100')
 colgroup='<colgroup>'+''.join(f'<col style="width:{int(width)}%">' for width in widths)+'</colgroup>' if widths else ''
 return f'<div class="table-scroll cols-{len(columns)}" tabindex="0"><span class="table-hint">左右滑动查看完整表格 →</span><table>'+colgroup+'<thead><tr>'+''.join(f'<th scope="col">{scenario_inline(column)}</th>' for column in columns)+'</tr></thead><tbody>'+''.join('<tr>'+''.join(f'<td>{scenario_inline(cell)}</td>' for cell in row)+'</tr>' for row in rows)+'</tbody></table></div>'

def use_case_page(case):
 done=case.get('done',[])
 boundaries=case.get('boundaries',[])
 steps=''.join(f'<li><strong>{html.escape(step["label"])}</strong><p>{scenario_inline(step["detail"])}</p>'+render_notes(step.get('notes',[]),scenario_inline)+'</li>' for step in case['steps'])
 steps_title=case.get('steps_title','操作步骤')
 choices=case.get('connection_choices')
 choices_html=(f'<p>{scenario_inline(choices["intro"])}</p>'+comparison_table(choices)+render_notes(choices.get('notes',[]),scenario_inline)) if choices else ''
 choices_text=' '.join([choices['intro'],*choices['columns'],*(cell for row in choices['rows'] for cell in row),*choices.get('notes',[])]) if choices else ''
 sections=[('scene','使用场景'),('roles','参与者与前提'),('steps',steps_title)]+([('done','完成标志')] if done else [])+([('boundaries','补充说明')] if boundaries else [])
 supplements=[];supplement_headings=[];supplement_sections=[]
 for supplement in case.get('supplements',[]):
  identifier=supplement['id'];title=supplement['title']
  supplement_steps=''.join(f'<li><strong>{html.escape(step["label"])}</strong><p>{scenario_inline(step["detail"])}</p>'+render_notes(step.get('notes',[]),scenario_inline)+'</li>' for step in supplement['steps'])
  supplements.append(heading(identifier,title)+f'<p>{scenario_inline(supplement["intro"])}</p>'+render_notes(supplement.get('notes',[]),scenario_inline)+case_diagram(supplement['diagram'],identifier)+f'<ol class="case-steps">{supplement_steps}</ol>')
  supplement_headings.append({'id':identifier,'title':title,'level':'h2'})
  supplement_sections.append({'id':identifier,'title':title,'text':plain(' '.join([supplement['intro'],*supplement.get('notes',[]),*(step['label']+' '+step['detail']+' '+' '.join([*step.get('actions',[]),*step.get('notes',[])]) for step in supplement['steps'])]))})
 body=(heading(case['id']+'-scene','使用场景')+f'<p class="home-intro">{html.escape(case["situation"])}</p>'
       +heading(case['id']+'-roles','参与者与前提')+actor_table(case['actors'])+bullet_list(case['prerequisites'])
       +render_notes(case.get('notes',[]),scenario_inline)
       +('<p class="next-actions">准备步骤：'+' · '.join(internal_link(target) for target in case['prerequisite_targets'])+'</p>' if case.get('prerequisite_targets') else '')
       +heading(case['id']+'-steps',steps_title)+choices_html+(f'<p>{scenario_inline(case["steps_intro"])}</p>' if case.get('steps_intro') else '')+case_diagram(case['diagram'],case['id'])+f'<ol class="case-steps">{steps}</ol>'
       +''.join(f'<p>{scenario_inline(paragraph)}</p>' for paragraph in case.get('steps_after',[]))
       +(heading(case['id']+'-done','完成标志')+bullet_list(done) if done else '')
       +''.join(supplements)
       +(heading(case['id']+'-boundaries','补充说明')+render_notes(boundaries,scenario_inline) if boundaries else ''))
 diagram_text=' '.join([case['diagram']['caption'],*(lane['label']+' '+' '.join(lane['nodes']) for lane in case['diagram']['lanes'])])
 sections_text=[('scene',case['situation']),
                ('roles',' '.join(actor['name']+' '+actor['role'] for actor in case['actors'])+' '+' '.join([*case['prerequisites'],*case.get('notes',[])])),
                ('steps',' '.join([choices_text,case.get('steps_intro',''),*(step['label']+' '+step['detail']+' '+' '.join(step.get('notes',[])) for step in case['steps']),*case.get('steps_after',[])])),
                ('done',' '.join(done)),('boundaries',' '.join(boundaries))]
 sections_text=[(identifier,plain(content)) for identifier,content in sections_text if identifier in dict(sections)]
 headings=[{'id':case['id']+'-'+suffix,'title':title,'level':'h2'} for suffix,title in sections if suffix!='boundaries']+supplement_headings
 search_sections=[{'id':case['id']+'-'+suffix,'title':dict(sections)[suffix],'text':content} for suffix,content in sections_text if suffix!='boundaries']+supplement_sections
 if boundaries:
  headings.append({'id':case['id']+'-boundaries','title':'补充说明','level':'h2'})
  search_sections.append({'id':case['id']+'-boundaries','title':'补充说明','text':plain(' '.join(boundaries))})
 return {'id':case['id'],'title':case['title'],'group':GROUPS[case['id']],
         'html':body,
         'headings':headings,
         'sections':search_sections,
         'text':' '.join([diagram_text,*(content for _,content in sections_text),*(section['text'] for section in supplement_sections)])}

def enrich_algorithm_example(article):
 spec=STRUCTURE['example_details']
 scene_id='example-scene';roles_id='example-roles';walk_id='example-walkthrough';checks_id='example-checks'
 article['html']=(heading(scene_id,'使用场景')+f'<p class="home-intro">{html.escape(spec["summary"])}</p>'
                  +heading(roles_id,'参与者与共同目标')+actor_table(spec['actors'])
                  +heading(walk_id,'逐轮协作过程')+case_diagram(spec['diagram'])
                  +heading(checks_id,'完成时核对')+bullet_list(spec['checks'])
                  +'<p class="related-note">对应操作：'+' · '.join(internal_link(target) for target in spec['targets'])+'</p>')
 article['headings']=[{'id':identifier,'title':title,'level':'h2'} for identifier,title in
                      [(scene_id,'使用场景'),(roles_id,'参与者与共同目标'),(walk_id,'逐轮协作过程'),(checks_id,'完成时核对')]]
 roles_text=' '.join(actor['name']+' '+actor['role'] for actor in spec['actors'])
 article['sections']=[{'id':scene_id,'title':'使用场景','text':spec['summary']},
                      {'id':roles_id,'title':'参与者与共同目标','text':roles_text},
                      {'id':walk_id,'title':'逐轮协作过程','text':''},
                      {'id':checks_id,'title':'完成时核对','text':' '.join(spec['checks'])}]
 article['text']=' '.join([spec['summary'],roles_text,*spec['checks'],*(DESTINATION_TITLES[target] for target in spec['targets'])])

def add_related(article,lead,targets):
 note=f'<p class="related-note">{html.escape(lead)}'+ ' · '.join(internal_link(target) for target in targets)+'</p>'
 marker='<p class="next-actions"'
 position=article['html'].rfind(marker)
 if position>=0: article['html']=article['html'][:position]+note+article['html'][position:]
 else: article['html']+=note
 article['text']+=' '+lead+' '+' '.join(DESTINATION_TITLES[target] for target in targets)

def main(capture_ui=True):
 DESTINATION_TITLES.clear();RELATED_FRAGMENT_TARGETS.clear()
 subprocess.run([sys.executable,str(ROOT/'scripts/build-manual-diagrams.py'),'--handbook-roles'],cwd=ROOT,check=True)
 if capture_ui:
  subprocess.run(['node',str(ROOT/'scripts/capture-handbook-app-ui.mjs')],cwd=ROOT,check=True)
 source=editorial_notes(document_paths((DOCS/'user-guide.md').read_text(encoding='utf-8')))
 for image_name in ['admin-users','admin-groups','admin-storage']:
  source=source.replace('images/user-manual/'+image_name+'.png','handbook/ui-screens/'+image_name+'.png')
 # Keep link sentences readable after the HTML view displays destination titles.
 html_only_edits={
  '全新共享空间先按界面初始化；已有团队使用现有配置，不重新初始化。':'首次启用团队服务器，请按[首次启用团队空间](#case-team-setup)完成连接、环境检查和初始化。已有团队使用原服务器地址和团队根路径连接。',
  '团队页默认仅展示与当前账号个人库有差异的成果；组管理员勾选**包含个人库已有成果**可查看全部团队原件。该选项只改变列表范围，不编辑或导入内容。团队表示项目成员共享，不按“未操作 / 已操作”或“待整理 / 已整理”分组；针对对话的整理任务在左侧**成果整理**中查看。':'团队页默认展示与当前账号个人库有差异的成果。组管理员勾选**包含个人库已有成果**可查看全部团队原件。会话产生的整理任务在左侧**成果整理**中查看。',
  '可按[管理端网络出口](#gateway)的步骤接入管理员提供的转发通路':'接入管理员转发通路的做法见[管理端网络出口](#gateway)',
  '确需借用管理端出口时，按[用户端接入步骤](#section-14-2)填写接入码。':'确需借用管理端出口时，填写接入码的方法见[用户端接入](#section-14-2)。',
  '普通文件和轨迹可[单独上传](#files)':'普通文件和轨迹的操作见[单独上传](#files)',
  '服务器环境待完善时按[管理问题处理](#section-16-3)操作，详细准备步骤见独立部署指导':'服务器环境待完善时，排查入口见[管理问题处理](#section-16-3)；详细准备步骤见独立部署指导'
 }
 for old,new in html_only_edits.items(): source=source.replace(old,new)
 for identifier,_,title in re.findall(r'<a id="([^"]+)"></a>\s*\n(#{2,3})\s+([^\n]+)',source):
  title=re.sub(r'^\d+(?:\.\d+)?\s+','',title).strip()
  DESTINATION_TITLES[identifier]=DISPLAY_TITLES.get(identifier,title)
 for _,(identifier,title) in RELATED.items(): DESTINATION_TITLES[identifier]=DISPLAY_TITLES.get(identifier,title)
 for spec in STRUCTURE['quickstarts']: DESTINATION_TITLES[spec['id']]=spec['title']
 for case in STRUCTURE['use_cases']:
  DESTINATION_TITLES[case['id']]=case['title']
  for supplement in case.get('supplements',[]): DESTINATION_TITLES[supplement['id']]=supplement['title']
 DESTINATION_TITLES['beta-features']='Beta 功能'
 DESTINATION_TITLES['questions']=STRUCTURE['questions']['title']
 DESTINATION_TITLES.update({s['id']:s['title'] for s in STRUCTURE['questions']['sections']})
 DESTINATION_TITLES.update({'common-actions':'常用操作','complete-task-index':'按任务查找',
                            'egress-path':EGRESS_PATH_TITLE,
                            'egress-scenarios':'查看接入管理端的操作教程'})
 for filename,(identifier,_) in RELATED.items():
  raw=editorial_notes(document_paths((DOCS/filename).read_text(encoding='utf-8'))); pending=None; number=0
  for line in raw.splitlines():
   anchor=re.fullmatch(r'<a id="([^"]+)"></a>',line.strip())
   if anchor: pending=anchor[1]; continue
   heading=re.match(r'^(#{2,4}) (.+)$',line.strip())
   if not heading: continue
   number+=1; title=re.sub(r'^\d+\.\d+\s+','',heading[2]).strip()
   target_id=pending or identifier+'-topic-'+str(number); pending=None
   slug=re.sub(r'\s+','-',re.sub(r'[^\w\s-]','',heading[2].lower())).strip('-')
   RELATED_FRAGMENT_TARGETS[(filename,slug)]=target_id
   DESTINATION_TITLES[target_id]=title
 pattern=r'<a id="([^"]+)"></a>\s*\n## ([^\n]+)'
 matches=list(re.finditer(pattern,source)); articles=[]
 for i,m in enumerate(matches):
  identifier=m[1]; title=DISPLAY_TITLES.get(identifier,re.sub(r'^\d+ ','',m[2])); end=matches[i+1].start() if i+1<len(matches) else len(source)
  body,headings,sections=render(source[m.end():end].splitlines())
  articles.append({'id':identifier,'title':title,'group':GROUPS[identifier],'html':body,'headings':headings,'sections':sections,'text':plain(source[m.end():end])})
 for filename,(identifier,title) in RELATED.items():
  raw=editorial_notes(document_paths((DOCS/filename).read_text(encoding='utf-8'))); body,headings,sections=render(raw.splitlines(),identifier+'-')
  articles.append({'id':identifier,'title':DESTINATION_TITLES[identifier],'group':GROUPS[identifier],'html':body,'headings':headings,'sections':sections,'text':plain(raw)})
 articles.extend(quickstart_page(spec) for spec in STRUCTURE['quickstarts'])
 articles.extend(use_case_page(spec) for spec in STRUCTURE['use_cases'])
 articles.append(beta_features_page())
 articles.append(questions_page())
 article_by_id={article['id']:article for article in articles}
 if len(article_by_id)!=len(articles): raise ValueError('Duplicate handbook page ID')
 if set(article_by_id)!=set(PAGE_ORDER):
  raise ValueError(f'Handbook structure mismatch: missing={set(article_by_id)-set(PAGE_ORDER)}, extra={set(PAGE_ORDER)-set(article_by_id)}')
 enrich_home(article_by_id['start'])
 add_related(article_by_id['sessions'],'向项目组成员请教与接收答复：',['questions','case-member-questions'])
 add_related(article_by_id['activity'],'接收和回复成员提问：',['questions-reply','case-member-questions'])
 add_related(article_by_id['sessions'],'跨会话引用的开关和操作：',['beta-features'])
 enrich_algorithm_example(article_by_id['example'])
 enrich_gateway(article_by_id['gateway'])
 article_by_id['deployment']['html']=(
  '<p class="read-first">团队项目和成果通过 SSH/SFTP 访问 Linux 服务器。个人网络账号无法与模型服务完整交互时，成员可按'
  +internal_link('egress-path')+'接入具备相应权限的管理端网络。完整操作见'+internal_link('case-egress-mixed')+'。</p>'
  +article_by_id['deployment']['html'])
 article_by_id['deployment']['text']+=' 团队 SSH/SFTP 共享服务器中转 管理端反向隧道 Codex Cursor'
 add_related(article_by_id['conclusions'],'成果分类的设置与使用细节：',['classification-reference-topic-1'])
 add_related(article_by_id['tasks'],'任务入口及文件的详细边界：',['classification-reference-tasks','classification-reference-task-files'])
 add_related(article_by_id['people'],'首次启用团队服务器，按界面完成：',['case-team-setup'])
 add_related(article_by_id['deployment'],'首次部署操作示例：',['case-team-setup'])
 add_related(article_by_id['egress-reference'],'按界面操作：',['section-14-1','section-14-2'])
 articles=[article_by_id[identifier] for identifier in PAGE_ORDER]
 all_targets=[identifier for article in articles for identifier in [article['id'],*(h['id'] for h in article['headings'])]]
 if len(all_targets)!=len(set(all_targets)): raise ValueError('Duplicate handbook page or heading ID')
 stale_titles=set(DISPLAY_TITLES)-set(all_targets)
 if stale_titles: raise ValueError(f'Title overrides without destinations: {stale_titles}')
 actual_titles={article['id']:article['title'] for article in articles}
 actual_titles.update({heading['id']:heading['title'] for article in articles for heading in article['headings']})
 for target,title in DESTINATION_TITLES.items():
  if target not in actual_titles: raise ValueError(f'Title target not rendered: {target}')
  if actual_titles[target]!=title: raise ValueError(f'Title drift at {target}: {title} != {actual_titles[target]}')
 data=json.dumps(articles,ensure_ascii=False).replace('</',r'<\/')
 navigation=json.dumps({'groups':STRUCTURE['groups'],
                        'search_defaults':STRUCTURE['home']['search_defaults']},ensure_ascii=False).replace('</',r'<\/')
 template=(WEB/'template.html').read_text(encoding='utf-8')
 meta=read_meta()
 template=(template.replace('/*__VERSION__*/',meta.version)
           .replace('/*__SOFTWARE_VERSION__*/',meta.software_version)
           .replace('/*__COMMIT__*/',meta.commit)
           .replace('/*__DATE__*/',meta.date)
           .replace('/*__FILENAME__*/',meta.filename))
 script=(WEB/'handbook.js').read_text(encoding='utf-8').replace('/*__VERSION__*/',meta.version).replace('/*__SOFTWARE_VERSION__*/',meta.software_version)
 output=(template.replace('/*__STYLE__*/',(WEB/'handbook.css').read_text(encoding='utf-8'))
         .replace('/*__SCRIPT__*/',script).replace('/*__ARTICLES__*/',data)
         .replace('/*__STRUCTURE__*/',navigation))
 (WEB/'index.html').write_text(output,encoding='utf-8')
 # Preserve the interface walkthroughs whenever the handbook is rebuilt.
 from handbook_ui_scenarios import enhance_html
 enhance_html(WEB/'index.html',capture_ui=False)
 print(f'Built {len(articles)} topics, {sum(len(a["sections"]) for a in articles)} sections; {len(output.encode())} bytes. No external runtime dependencies.')

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--reuse-screens',action='store_true',help='Reuse reviewed screenshots for text and layout edits.')
 args=parser.parse_args()
 main(capture_ui=not args.reuse_screens)
