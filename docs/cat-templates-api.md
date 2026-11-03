# 正式前端：猫猫模板接口约定（2026-11-03）

状态：已实现并通过真实 HTTP 联调。模板库与实例化由外置 `patches/0005-cat-templates.patch` 提供，Bot 路由只做协议适配；完整实现说明见 [后端设计](cat-templates-design.md)。

用户本轮要求：正式前端、每种猫一个默认模板、平铺列表、从零开始放最后、删除冗余说明。前端不能依赖 template-lab 的 fixture/sessionStorage。数据必须来自真实接口；失败明确显示，不能回退假成功。

## DTO

```ts
type Choice = {mode:'inherit'} | {mode:'explicit'; value:string};
type BreedChoice = {mode:'auto'} | {mode:'explicit'; breedId:string};
interface CatConfig {
  runtimeId:string|null;
  breed:BreedChoice;
  model:Choice;
  effort:Choice;
  portrait:{roleDescription:string; personality?:string; teamStrengths?:string; strengths?:string[]; caution?:string|null};
}
interface CatTemplate extends CatConfig {
  id:string;
  revision:number;
  name:string;
  nameHint:string;
  source:{kind:'native-seed'|'user'; breedId?:string; variantId?:string};
}
interface Breed {id:string;name:string}
```
模型为空/跟随 Agent 默认：保存 Choice.inherit。effort 是否支持以原生 runtime-models 为依据：模型的 efforts 优先，其次匹配查询模型的 effortOptions；字段缺失=未知，显式空数组=不支持。未知可保留原显式值并手填，不能降档，也不需要常驻长篇说明；具体错误在失败时显示。

## 模板

- GET `/xbot-api/cat-templates` → `{templates:CatTemplate[], breeds:Breed[]}`。默认 8 个，不按族分组；每个内置猫种一个，不复制所有 variant。
- GET `/xbot-api/cat-templates/:id` → `{template:CatTemplate}`。
- POST `/xbot-api/cat-templates` body `{name,nameHint,...CatConfig}` → `{template:CatTemplate}`，201。
- PUT `/xbot-api/cat-templates/:id` body `{name,nameHint,...CatConfig,expectedRevision:number}` → `{template:CatTemplate}`。
- DELETE `/xbot-api/cat-templates/:id` body `{expectedRevision:number}` → `{status:'ok'}`。
- 409 显示简短冲突提示并重新读取；404 不可假装已保存；删除模板不改已有猫猫。
- 任何来源 ID、修订、来源变体均仅内部使用，不在正常页面列出来。

## Agent 和模型

- 继续 GET `/xbot-api/agents`，返回的 `agents` 沿用现有 DTO。不得以 fixture 填充。
- POST `/xbot-api/agents/:id/models` body `{model?:string,refresh?:boolean}` → 原生 runtime-models 响应：`{status:'live'|'configured'|'unavailable',models:[{value,label,efforts?:[{value,label}]}],defaultModel?,defaultEffort?,selectedModel?,effortOptions?:[{value,label}]}`。
- 查询只按已发现 runtimeId，不提供自定义命令、供应商、凭据。

## 创建

- POST `/xbot-api/bots` body `{name,catConfig:CatConfig,idempotencyKey:string,sourceTemplate?:{id,revision},avatar_seed?,timezone?}` → 沿用 `{name,native_id}`。`idempotencyKey` 必须是 UUID；相同请求重试复用同一个值，配置改变时生成新值。
- 原生保存创建预约，并复用成员创建回执。超时后重试返回同一成员；同一键配不同请求返回 409。来源模板在首次预约前已改变时返回 409；预约成功后即使来源模板被修改或删除，原请求仍可安全重试。
- `catConfig` 是所选模板的独立副本，展开微调后发送修改后的值。`sourceTemplate` 只是来源/修订检查，模板不随猫猫一起改变。
- 完全从零不传 sourceTemplate，配置项直接展开；有模板时默认收起。创建按钮禁用只基于必填/明确无法使用，不把未知模型自行判定成不存在。
- 保留左上 + 原菜单入口，创建成功沿用 refreshLists/selectBot，关弹层，进入真实聊天；不发送消息、不自动启动 Agent。
- 原 `templateId` 是头像/角色兼容字段，不能用它传新模板 ID。

## 已有猫猫

`GET /xbot-api/bots/:name` 增加 `cat_config:CatConfig|null` 与 `source_template:{id,revision,name}|null`；配置来自原生 cat，不从后来被修改的模板读。
原“人设卡”选择不能继续承诺实时绑定模板；编辑资料里保留直接职责编辑，新增模板只影响新建；去掉旧“应用人设卡”控件。资料 JSON 导入导出更名为“导入资料/导出资料”以免与模板混淆，行为保留。
