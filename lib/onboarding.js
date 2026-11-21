/**
 * 要注册的厂商清单：签到方式、领取路径、以及注册后怎么接进 DSH。
 *
 * 与 AIHOT 清单的区别：那份是「全网所有免费额度」（含只限产品内使用的、
 * 与 LLM 无关的），这份是**能直接接成 DSH provider 的那批** —— 注册完拿到
 * API Key，填进 DSH 的模型设置，插件的模型池就能自动接管它。
 *
 * 判定「能接进 DSH」的三条硬标准：
 *   1. 提供 OpenAI 兼容或 Anthropic 兼容的 API（否则要自己写 adapter）；
 *   2. 有可申请的个人 API Key（不是只能在网页里聊天）；
 *   3. 额度按 token 计、调用即消耗（能进探针与调度）。
 *
 * @module onboarding
 */

/**
 * @typedef {object} VendorPlan
 * @property {string} id
 * @property {string} name - 厂商名
 * @property {string} provider - 对应的 DSH provider id（已装的填 id，没装的留空表示需要先装插件）
 * @property {string} dshProviderName - DSH 里显示的名字
 * @property {'daily' | 'weekly' | 'monthly' | 'once' | 'timed'} cadence - 领取节奏
 * @property {string} amount - 能领多少
 * @property {string} how - 怎么领
 * @property {string} claimUrl - 领取/注册入口
 * @property {string} apiKeyUrl - 拿 API Key 的地方
 * @property {string} needsRealname - 是否要实名
 * @property {string} deadline - 截止时间（原文）
 * @property {string} notes - 备注
 */

/** @type {VendorPlan[]} */
export const VENDOR_PLANS = [
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    provider: 'siliconflow',
    dshProviderName: 'SiliconFlow',
    cadence: 'monthly',
    amount: '¥16 通用代金券（180 天有效）；另有一批模型定价页标 0 元（OCR/语音/向量/生图）',
    how: '实名认证后手动领一张 16 元通用代金券，老用户也能领。定价页标「免费」的模型直接按 0 元调用',
    claimUrl: 'https://www.siliconflow.cn/news/od7wj9rr23p95uhihmhrombp',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    needsRealname: '要实名',
    deadline: '代金券 2027-01-01 00:00',
    notes: 'OpenAI 兼容；老用户也能领那张券'
  },
  {
    id: 'bailian',
    name: '阿里云百炼 Model Studio',
    provider: 'bailian',
    dshProviderName: 'Bailian',
    cadence: 'once',
    amount: '部分模型各送 100 万 Token（Qwen4 Max 官方价折算 ≈¥5.4 起，每个模型各一份，90 天有效）',
    how: '首次开通百炼自动发放，需实名认证。必须用**通用 API Key** 调实时推理才吃这份额度（Batch/调优/部署/存储/套餐专属 Key 不算）',
    claimUrl: 'https://help.aliyun.com/zh/model-studio/new-free-quota',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    needsRealname: '要实名、只限北京地域',
    deadline: '无（额度按开通日起 90 天）',
    notes: '**学生党另有 ¥300**：中国高校在读学生实名后可领，每 12 个月一次，每日限量'
  },
  {
    id: 'bailian-student',
    name: '阿里云百炼 · 在读学生 ¥300',
    provider: 'bailian',
    dshProviderName: 'Bailian（学生额度）',
    cadence: 'yearly',
    amount: '¥300 模型抵扣金（一年有效）',
    how: '中国高校在读学生完成实名认证后领取，认证有效期内每 12 个月领一次，每日数量有限',
    claimUrl: 'https://help.aliyun.com/zh/model-studio/introduction-to-yungongkaiwu',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    needsRealname: '要实名、仅在读学生',
    deadline: '2027-03-31 23:59',
    notes: '额度最大的单笔，值得优先办；与上面的新人额度可叠加'
  },
  {
    id: 'volcengine',
    name: '火山方舟（豆包）',
    provider: 'volcengine',
    dshProviderName: 'Volcengine Ark',
    cadence: 'once',
    amount: '4 款豆包模型各送 50 万 Token',
    how: '注册火山引擎即得免费推理额度，**无需先实名**；按模型独立，只抵扣按 Token 后付费的在线推理',
    claimUrl: 'https://docs.volcengine.com/docs/ark/free-inference-quota',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    needsRealname: '注册即可，付费才需实名',
    deadline: '无',
    notes: 'OpenAI 兼容（豆包系列）；DSH 需先装对应 adapter 插件'
  },
  {
    id: 'agnes',
    name: 'Agnes AI',
    provider: 'agnes',
    dshProviderName: 'Agnes',
    cadence: 'timed',
    amount: '指定 Flash 型号限时免费（Agnes 3.0 Flash、Image 2.0/2.1/2.5 Flash、Video 2.5 Flash）',
    how: '在中国站用免费／默认账号创建**免费 API 密钥**后调用；Pro 系列与普通 Video 2.5 仍收费',
    claimUrl: 'https://wiki.agnes-ai.cn/zh-Hans/docs/pricing',
    apiKeyUrl: 'https://platform.agnes-ai.cn/console/api-keys',
    needsRealname: '只要免费密钥（付费订阅不适用）',
    deadline: '以官方定价页为准',
    notes: 'DSH 里已装 agnes provider，但池状态是 unknown → 说明还没配 Key'
  },
  {
    id: 'qiniu',
    name: '七牛云',
    provider: 'qiniu',
    dshProviderName: 'Qiniu AI',
    cadence: 'timed',
    amount: 'Nemotron 3 Ultra 免费版输入/输出均 0 元',
    how: '登录七牛云后，在控制台创建 API Key，调用 nvidia/nemotron-3-ultra-550b-a55b0-free',
    claimUrl: 'https://www.qiniu.com/ai/models',
    apiKeyUrl: 'https://portal.qiniu.com/user/key',
    needsRealname: '未标注',
    deadline: '以官方模型详情为准',
    notes: 'OpenAI 兼容；只免费这一款模型'
  },
  {
    id: 'minicpm',
    name: '面壁智能 MiniCPM',
    provider: 'minicpm',
    dshProviderName: 'ModelBest',
    cadence: 'timed',
    amount: 'MiniCPM-OCR-1.0 / MiniCPM-OCR-Jev 输入输出限时免费；MiniCPM-V-4.7 系列也标「限时免费」',
    how: '登录面壁国内开放平台后创建 API Key',
    claimUrl: 'https://platform.modelbest.cn/console/docs/models',
    apiKeyUrl: 'https://platform.modelbest.cn/console/api-keys',
    needsRealname: '未标注',
    deadline: '以平台为准',
    notes: '兼容 OpenAI / Anthropic 请求格式；文本/多模态/语音都有'
  },
  {
    id: 'modelscope',
    name: '魔搭社区 ModelScope',
    provider: 'modelscope',
    dshProviderName: 'ModelScope',
    cadence: 'daily',
    amount: '每天 200 魔粒（绑阿里云账号再 +50）',
    how: '每日登录即可领 200 魔粒。调 API-Inference 需绑定**已实名**的阿里云账号、完善个人信息、验证邮箱',
    claimUrl: 'https://www.modelscope.cn/posts/435591',
    apiKeyUrl: 'https://modelscope.cn/my/myaccesstoken',
    needsRealname: '要实名 + 绑阿里云账号 + 验证邮箱',
    deadline: '无',
    notes: '**每天都要签到**，是这批里唯一真正需要每天操作的'
  },
  {
    id: 'baidu-qianfan',
    name: '百度千帆',
    provider: 'baidu-qianfan',
    dshProviderName: 'Baidu Qianfan',
    cadence: 'once',
    amount: '¥20 代金券（≈GLM-5.3 345 万 Token）',
    how: '首次注册百度千帆并完成实名认证后获得',
    claimUrl: 'https://cloud.baidu.com/doc/qianfan/index.html',
    apiKeyUrl: 'https://console.bce.baidu.com/qianfan/ais/console/apikeylist',
    needsRealname: '要实名',
    deadline: '2026-11-30 23:59',
    notes: 'OpenAI 兼容'
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    provider: 'cloudflare',
    dshProviderName: 'Cloudflare Workers AI',
    cadence: 'daily',
    amount: '每天 1 万 Neurons（北京时间 08:00 重置，不累积）',
    how: '免费计划通过 Workers 或 REST API 调用，所有调用共用每天 10,000 Neurons，用尽即报错',
    claimUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    apiKeyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    needsRealname: '无需（信用卡仅部分前沿模型需要）',
    deadline: '无',
    notes: '**每天 08:00 自动重置，不用手动签到**；覆盖 Qwen3.8-27B、GPT-OSS 120B/20B、Gemma 4 26B、Llama 4 Scout 等'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    provider: 'minimax',
    dshProviderName: 'MiniMax / minimax-cn',
    cadence: 'daily',
    amount: 'MiniMax M3 等型号每天有免费额度，用完后转为扣积分',
    how: '在 MiniMax 开放平台每日登录领取免费额度；用完后继续调用会扣积分',
    claimUrl: 'https://platform.minimaxi.com/',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    needsRealname: '要实名',
    deadline: '以官方活动页为准',
    notes: '你已充值 5 小时额度的就是这条通道（minimax-cn / MiniMax-M3）'
  }
]

/** 节奏的中文标签。 */
export const CADENCE_LABEL = Object.freeze({
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
  once: '一次性',
  timed: '限时'
})

/**
 * 按 DSH provider 分组，便于面板显示「哪个通道还没配 Key」。
 * @param {VendorPlan[]} [plans]
 * @returns {Array<{ provider: string, name: string, items: VendorPlan[] }>}
 */
export function groupPlans(plans = VENDOR_PLANS) {
  /** @type {Map<string, { provider: string, name: string, items: VendorPlan[] }>} */
  const groups = new Map()
  for (const plan of plans) {
    let group = groups.get(plan.provider)
    if (!group) {
      group = { provider: plan.provider, name: plan.dshProviderName, items: [] }
      groups.set(plan.provider, group)
    }
    group.items.push(plan)
  }
  return [...groups.values()]
}

/**
 * 每个通道对应的凭据环境变量名。
 *
 * 用途：面板要能回答「这个通道我到底配没配 Key」—— 只能查本机凭据库，
 * 不能靠猜。用户已经配好的（如 AGNES_API_KEY / SILICONFLOW_API_KEY）绝不能
 * 再让他去注册一遍。
 */
export const PROVIDER_CRED_ENV = Object.freeze({
  siliconflow: 'SILICONFLOW_API_KEY',
  bailian: 'BAILIAN_API_KEY',
  agnes: 'AGNES_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  spark: 'SPARK_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  qiniu: 'QINIU_API_KEY',
  minicpm: 'MODELBEST_API_KEY',
  modelscope: 'MODELSCOPE_API_KEY',
  'baidu-qianfan': 'QIANFAN_API_KEY',
  volcengine: 'ARK_API_KEY',
  cloudflare: 'CLOUDFLARE_API_TOKEN'
})
