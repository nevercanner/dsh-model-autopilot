/**
 * Model Autopilot — 浏览器半身。
 *
 * 两处贡献：
 *   1. `sidebar.panellist` 的导航图标（左侧栏入口）；
 *   2. `main` 插槽里 key 同名的面板（点击入口后主区域显示的内容）。
 *
 * 为什么两处都要注册：侧栏的 panellist 条目只负责「点它会 selectPanel(id)」，
 * 真正渲染面板的是 `renderSlot("main", {}, { entryKey: activePanelId })`
 * （dsh-client-ui-layout/lib/client.js:119）。只注册入口会点出一个空白主区域。
 *
 * 数据来自本插件自己的 same-origin 路由 `/api/model-autopilot`（不用 Remote：
 * 这里只需要读状态 + 触发探测，前缀路由注册即用、随 fiber 释放即消失）。
 *
 * 手写 ModuleLoader bundle：无构建步骤，只依赖 shell 已提供的 `react`；
 * 颜色全部走主题变量并带 fallback，深浅色切换不用额外适配。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-model-autopilot',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    const NS = 'modelAutopilot'
    const PANEL_ID = 'model-autopilot'
    const API = '/api/model-autopilot'
    const POLL_MS = 5000

    const inject = ['slots', 'locale']

    const DICT = {
      zh: {
        panel: '模型调度',
        title: '模型调度（免费优先）',
        subtitle: '探针决定哪些模型可选；失效的会同时从选择界面移除。',
        free: '免费',
        paid: '付费',
        hidden: '已隐藏',
        total: '总数',
        probe: '探针',
        probeIdle: '尚未运行',
        probeLast: '上次',
        probeDue: '到期',
        lastPick: '最近选型',
        none: '暂无',
        blocked: '当前不可见的模型',
        noBlocked: '没有失效模型 —— 全部可用。',
        cooldown: '冷却',
        failCount: '连败',
        runProbe: '立即探测',
        running: '探测中…',
        refresh: '刷新',
        loading: '读取中…',
        error: '读取失败',
        triggered: '已触发一轮探测',
        probeOne: '探测',
        probingOne: '探测中',
        probeFailed: '探测失败',
        pinned: '首选模型',
        pinnedHint: '锁定的 provider 排第一，压过免费优先；它一旦失效（冷却/熔断）自动让位给免费模型。',
        quota: '额度情报',
        quotaHint: '来自 AIHOT「Token 羊毛」：哪些通道现在有免费额度、什么时候截止、怎么领。额度要自己去厂商官网领。',
        quotaNone: '暂无额度情报',
        quotaUsable: '有免费额度',
        quotaExpired: '额度已过期',
        quotaFetch: '刷新情报',
        quotaSyncing: '同步中…',
        quotaTotal: '清单条目',
        quotaProviders: '通道',
        quotaClaim: '去领',
        onboarding: '注册与签到',
        onboardingHint: '注册拿 API Key → 填进 DSH 模型设置 → 插件自动接管这个通道。点标题打开领取页。',
        onboardActive: '已可用',
        onboardInstalled: '已装待配',
        onboardMissing: '需先装插件',
        onboardDaily: '需每天签到',
        onboardKeyReady: 'Key 已配',
        onboardKeyMissing: '未配 Key',
        pin: '设为首选',
        unpin: '取消首选',
        pinnedNone: '未锁定（当前按免费优先）',
        pinFailed: '设置失败',
        planTitle: '当前排序',
        health_dead: '失效',
        health_cooling: '冷却中',
        health_degraded: '降级',
        health_available: '可用',
        health_unknown: '未探测'
      },
      en: {
        panel: 'Model Autopilot',
        title: 'Model Autopilot (free first)',
        subtitle: 'Probes decide what is selectable; failed models also leave the picker.',
        free: 'free',
        paid: 'paid',
        hidden: 'hidden',
        total: 'total',
        probe: 'Probe',
        probeIdle: 'not run yet',
        probeLast: 'last',
        probeDue: 'due',
        lastPick: 'Last pick',
        none: 'none',
        blocked: 'Models hidden from the picker',
        noBlocked: 'No failed models — everything is available.',
        cooldown: 'cooldown',
        failCount: 'fails',
        runProbe: 'Probe now',
        running: 'Probing…',
        refresh: 'Refresh',
        loading: 'Loading…',
        error: 'Failed to load',
        triggered: 'A probe round was triggered',
        probeOne: 'Probe',
        probingOne: 'Probing',
        probeFailed: 'probe failed',
        pinned: 'Preferred provider',
        pinnedHint:
          'The pinned provider goes first, ahead of free models; when it fails (cooldown/dead) it yields to free models.',
        quota: 'Free-quota intel',
        quotaHint:
          'From AIHOT "Token 羊毛": which providers still have free quota, when it expires, and where to claim it. You claim it on the vendor site yourself.',
        quotaNone: 'no quota intel yet',
        quotaUsable: 'has free quota',
        quotaExpired: 'quota expired',
        quotaFetch: 'Refresh',
        quotaSyncing: 'Syncing…',
        quotaTotal: 'entries',
        quotaProviders: 'providers',
        quotaClaim: 'Claim',
        onboarding: 'Sign-up & daily check-in',
        onboardingHint:
          'Register for an API key → put it in DSH model settings → the plugin takes over that provider. Click a title to open the claim page.',
        onboardActive: 'working',
        onboardInstalled: 'installed, not configured',
        onboardMissing: 'plugin not installed',
        onboardDaily: 'daily check-in required',
        onboardKeyReady: 'Key configured',
        onboardKeyMissing: 'no key yet',
        pin: 'Pin',
        unpin: 'Unpin',
        pinnedNone: 'not pinned (free-first)',
        pinFailed: 'failed to pin',
        planTitle: 'Current order',
        health_dead: 'dead',
        health_cooling: 'cooling',
        health_degraded: 'degraded',
        health_available: 'available',
        health_unknown: 'unknown'
      }
    }

    const COLORS = {
      border: 'var(--dsw-alias-border-l3, rgba(128,128,128,0.28))',
      fill: 'var(--dsw-specific-sidebar-fill, transparent)',
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))',
      danger: 'var(--dsw-alias-state-error-primary, #d9534f)',
      warn: 'var(--dsw-alias-state-warning-primary, #c98a00)',
      ok: 'var(--dsw-alias-state-success-primary, #2f9e44)'
    }

    /** 左侧栏图标：三个层叠的方块，表示「多模型」。 */
    function AutopilotIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        },
        h('path', { d: 'M2.5 6.2 8 3.2l5.5 3-5.5 3z' }),
        h('path', { d: 'M2.5 9.8 8 12.8l5.5-3' })
      )
    }

    function healthColor(health) {
      if (health === 'dead') return COLORS.danger
      if (health === 'cooling') return COLORS.warn
      if (health === 'degraded') return COLORS.warn
      if (health === 'available') return COLORS.ok
      return COLORS.muted
    }

    function Stat(props) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 64 } },
        h('span', { style: { fontSize: 20, fontWeight: 600, color: COLORS.text } }, String(props.value)),
        h('span', { style: { fontSize: 11, color: COLORS.muted } }, props.label)
      )
    }

    /**
     * 一条模型：状态 + 该条的探测按钮。
     * 按钮点完只换这一行（带着服务端回的 entry 快照），不整页重载。
     */
    function Row(props) {
      const { entry, t, onProbe, probing, notice } = props
      const label = t('health_' + entry.health) || entry.health
      const noticeColor = notice === 'ok' ? COLORS.ok : COLORS.danger
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: '1fr auto auto auto auto',
              gap: 10,
              alignItems: 'center',
              padding: '7px 10px',
              border: '1px solid ' + COLORS.border,
              borderRadius: 8,
              fontSize: 12
            }
          },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h(
              'span',
              { style: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12 } },
              entry.key
            ),
            h(
              'span',
              { style: { color: COLORS.muted, fontSize: 11 } },
              [entry.verdict ? entry.verdict : '—', entry.latencyMs != null ? entry.latencyMs + 'ms' : null]
                .filter(Boolean)
                .join(' · ')
            )
          ),
          h('span', { style: { color: healthColor(entry.health), fontWeight: 500 } }, label),
          h(
            'span',
            { style: { color: COLORS.muted } },
            entry.cooldownLeft > 0 ? `${t('cooldown')} ${Math.ceil(entry.cooldownLeft / 1000)}s` : ''
          ),
          h(
            'span',
            { style: { color: entry.failCount > 0 ? COLORS.warn : COLORS.muted } },
            entry.failCount > 0 ? `${t('failCount')} ${entry.failCount}` : ''
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => onProbe(entry.key),
              disabled: probing,
              title: entry.key,
              style: {
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid ' + COLORS.border,
                background: 'transparent',
                color: COLORS.text,
                cursor: probing ? 'default' : 'pointer',
                opacity: probing ? 0.6 : 1,
                fontSize: 11
              }
            },
            probing ? t('probingOne') : t('probeOne')
          )
        ),
        notice ? h('div', { style: { fontSize: 11, color: noticeColor, paddingLeft: 10 } }, notice) : null
      )
    }

    function Panel() {
      const [state, setState] = React.useState({ status: 'loading' })
      const [probing, setProbing] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      /** 正在探测的单条 key（null = 没有）。 */
      const [probingKey, setProbingKey] = React.useState(null)
      /** 每条自己的反馈：成功是 verdict，失败是错误文本。 */
      const [rowNotices, setRowNotices] = React.useState({})
      /** 首选 provider（锁定后它排第一）。 */
      const [preference, setPreference] = React.useState({ provider: null, model: null })
      /** provider 下拉的选项（由模型清单汇总）。 */
      const [providerOptions, setProviderOptions] = React.useState([])
      /** 下拉当前选择。 */
      const [pinnedChoice, setPinnedChoice] = React.useState('')
      const [pinNotice, setPinNotice] = React.useState(null)
      /** 当前排序预览。 */
      const [planRows, setPlanRows] = React.useState([])
      /** 额度情报（AIHOT 羊毛清单）。 */
      const [quota, setQuota] = React.useState(null)
      const [quotaSyncing, setQuotaSyncing] = React.useState(false)
      /** 注册清单：哪些通道待配 Key、去哪领、要不要每天签到。 */
      const [onboarding, setOnboarding] = React.useState(null)
      const t = React.useMemo(() => {
        const locale = document.documentElement.lang || navigator.language || 'zh'
        const dict = locale.toLowerCase().startsWith('zh') ? DICT.zh : DICT.en
        return key => dict[key] || key
      }, [])

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(API, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const payload = await response.json()
          setState({ status: 'ready', data: payload })

          // 首选设置、provider 选项、当前排序：与状态一起刷新。
          const [prefRes, modelsRes, planRes] = await Promise.all([
            fetch(API + '/preference', { headers: { accept: 'application/json' } }),
            fetch(API + '/models', { headers: { accept: 'application/json' } }),
            fetch(API + '/plan', { headers: { accept: 'application/json' } })
          ])
          if (prefRes.ok) {
            const pref = await prefRes.json()
            const next = pref.preference ?? { provider: null, model: null }
            setPreference(next)
            setPinnedChoice(next.provider ?? '')
          }
          if (modelsRes.ok) {
            const models = await modelsRes.json()
            const grouped = new Map()
            for (const model of models.models ?? []) {
              const row = grouped.get(model.provider) ?? { id: model.provider, free: 0, paid: 0 }
              if (model.cost === 'free') row.free += 1
              else row.paid += 1
              grouped.set(model.provider, row)
            }
            setProviderOptions(
              [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id))
            )
          }
          if (planRes.ok) {
            const plan = await planRes.json()
            setPlanRows(plan.plan ?? [])
          }
          // 额度情报：拉不到就显示为空，不影响其它面板内容。
          try {
            const quotaRes = await fetch(API + '/quota', { headers: { accept: 'application/json' } })
            if (quotaRes.ok) setQuota(await quotaRes.json())
          } catch {
            /* 情报拿不到就当没有 */
          }
          try {
            const onboardRes = await fetch(API + '/onboarding', { headers: { accept: 'application/json' } })
            if (onboardRes.ok) setOnboarding(await onboardRes.json())
          } catch {
            /* 注册清单拿不到就当没有 */
          }
        } catch (error) {
          setState({ status: 'error', error: String(error && error.message ? error.message : error) })
        }
      }, [])

      React.useEffect(() => {
        let disposed = false
        let timer = null
        const tick = () => {
          if (disposed) return
          load().finally(() => {
            if (!disposed) timer = window.setTimeout(tick, POLL_MS)
          })
        }
        tick()
        return () => {
          disposed = true
          if (timer) window.clearTimeout(timer)
        }
      }, [load])

      /**
       * 单条探测：POST /probe?model=<provider/model>。
       * 成功时用服务端回的 entry 就地替换这一行（健康/冷却都可能是新的），
       * 失败时把错误写在这一行下面 —— 不允许静默。
       */
      const probeRow = React.useCallback(
        async key => {
          setProbingKey(key)
          setRowNotices(previous => ({ ...previous, [key]: null }))
          try {
            const response = await fetch(API + '/probe?model=' + encodeURIComponent(key), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}'
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok) {
              const error = payload && payload.error ? payload.error : 'HTTP ' + response.status
              setRowNotices(previous => ({ ...previous, [key]: error }))
              return
            }
            const fresh = payload && payload.entry
            if (fresh) {
              setState(previous =>
                previous.status === 'ready'
                  ? {
                      status: 'ready',
                      data: {
                        ...previous.data,
                        entries: previous.data.entries.map(item => (item.key === fresh.key ? fresh : item))
                      }
                    }
                  : previous
              )
            }
            const verdict = payload && payload.result ? payload.result.verdict : 'ok'
            setRowNotices(previous => ({ ...previous, [key]: verdict }))
          } catch (error) {
            setRowNotices(previous => ({
              ...previous,
              [key]: t('probeFailed') + ': ' + String(error && error.message ? error.message : error)
            }))
          } finally {
            setProbingKey(null)
          }
        },
        [t]
      )

      /**
       * 设置/取消首选 provider。
       * 这是插件的控制面：锁定后该 provider 排第一（压过免费优先），
       * 用来消耗用户充了额度的限时通道。
       */
      const applyPinned = React.useCallback(
        async provider => {
          setPinNotice(null)
          try {
            const response = await fetch(API + '/preference', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ provider })
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok) {
              setPinNotice((payload && payload.error) || 'HTTP ' + response.status)
              return
            }
            setPreference(payload.preference ?? { provider: null, model: null })
            setPinnedChoice(payload.preference?.provider ?? '')
            await load()
          } catch (error) {
            setPinNotice(t('pinFailed') + ': ' + String(error && error.message ? error.message : error))
          }
        },
        [t, load]
      )

      /** 手动同步额度情报。 */
      const syncQuota = React.useCallback(async () => {
        setQuotaSyncing(true)
        try {
          const response = await fetch(API + '/quota/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          })
          const payload = await response.json().catch(() => null)
          if (response.ok) {
            const quotaRes = await fetch(API + '/quota', { headers: { accept: 'application/json' } })
            if (quotaRes.ok) setQuota(await quotaRes.json())
          } else {
            setPinNotice((payload && payload.error) || 'HTTP ' + response.status)
          }
        } catch (error) {
          setPinNotice(String(error && error.message ? error.message : error))
        } finally {
          setQuotaSyncing(false)
        }
      }, [])

      const probe = async () => {
        setProbing(true)
        setNotice(null)
        try {
          const response = await fetch(API + '/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (!response.ok && response.status !== 202) throw new Error('HTTP ' + response.status)
          setNotice(t('triggered'))
          await load()
        } catch (error) {
          setNotice(String(error && error.message ? error.message : error))
        } finally {
          setProbing(false)
        }
      }

      const data = state.data
      const blocked = data ? (data.entries || []).filter(item => item.hidden) : []

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            padding: '20px 24px 32px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            color: COLORS.text,
            background: COLORS.fill
          }
        },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, t('title')),
          h('p', { style: { margin: 0, fontSize: 12, color: COLORS.muted } }, t('subtitle'))
        ),

        state.status === 'loading' && h('div', { style: { color: COLORS.muted, fontSize: 13 } }, t('loading')),
        state.status === 'error' &&
          h('div', { style: { color: COLORS.danger, fontSize: 13 } }, t('error') + ': ' + state.error),

        data &&
          h(
            'div',
            {
              style: {
                display: 'flex',
                gap: 24,
                padding: '12px 16px',
                border: '1px solid ' + COLORS.border,
                borderRadius: 10,
                alignItems: 'center',
                flexWrap: 'wrap'
              }
            },
            h(Stat, { label: t('total'), value: data.pool.total }),
            h(Stat, { label: t('free'), value: data.pool.free }),
            h(Stat, { label: t('paid'), value: data.pool.paid }),
            h(Stat, { label: t('hidden'), value: data.pool.hidden })
          ),

        data &&
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 } },
            h(
              'div',
              { style: { color: COLORS.muted } },
              t('probe') +
                ': ' +
                (data.probe.lastRoundAt
                  ? t('probeLast') + ' ' + new Date(data.probe.lastRoundAt).toLocaleTimeString()
                  : t('probeIdle')) +
                ' · ' +
                t('probeDue') +
                ' ' +
                String(data.probe.dueNow) +
                ' · ' +
                String(data.probe.intervalMs) +
                'ms'
            ),
            h(
              'div',
              { style: { color: COLORS.muted } },
              t('lastPick') +
                ': ' +
                (data.autopilot.lastResult
                  ? data.autopilot.lastResult.model.key + ' (' + data.autopilot.lastResult.reason + ')'
                  : t('none'))
            ),
            data.catalogFilter &&
              h(
                'div',
                { style: { color: COLORS.muted } },
                'catalog-filter: ' +
                  (data.catalogFilter.installed ? 'installed' : 'off') +
                  ' · calls ' +
                  String(data.catalogFilter.calls) +
                  ' · hidden ' +
                  String(data.catalogFilter.hidden)
              )
          ),

        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h(
            'button',
            {
              type: 'button',
              onClick: probe,
              disabled: probing,
              style: {
                padding: '7px 14px',
                borderRadius: 8,
                border: '1px solid ' + COLORS.border,
                background: 'var(--dsw-alias-button-elevated-fill, transparent)',
                color: COLORS.text,
                cursor: probing ? 'default' : 'pointer',
                opacity: probing ? 0.6 : 1,
                fontSize: 12
              }
            },
            probing ? t('running') : t('runProbe')
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: load,
              style: {
                padding: '7px 14px',
                borderRadius: 8,
                border: '1px solid ' + COLORS.border,
                background: 'transparent',
                color: COLORS.text,
                cursor: 'pointer',
                fontSize: 12
              }
            },
            t('refresh')
          ),
          notice && h('span', { style: { alignSelf: 'center', fontSize: 12, color: COLORS.muted } }, notice)
        ),

        // 首选 provider：插件的模型切换控制面。
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '12px 16px',
              border: '1px solid ' + COLORS.border,
              borderRadius: 10
            }
          },
          h('h3', { style: { margin: 0, fontSize: 13, fontWeight: 600 } }, t('pinned')),
          h('div', { style: { fontSize: 11, color: COLORS.muted } }, t('pinnedHint')),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(
              'select',
              {
                value: pinnedChoice,
                onChange: event => setPinnedChoice(event.target.value),
                style: {
                  padding: '6px 8px',
                  borderRadius: 8,
                  border: '1px solid ' + COLORS.border,
                  background: 'var(--dsw-alias-button-elevated-fill, transparent)',
                  color: COLORS.text,
                  fontSize: 12,
                  minWidth: 220
                }
              },
              h('option', { value: '' }, t('pinnedNone')),
              providerOptions.map(option =>
                h(
                  'option',
                  { value: option.id, key: option.id },
                  option.id + '（' + t('free') + ' ' + option.free + ' / ' + t('paid') + ' ' + option.paid + '）'
                )
              )
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => applyPinned(pinnedChoice),
                disabled: pinnedChoice === '',
                style: {
                  padding: '7px 14px',
                  borderRadius: 8,
                  border: '1px solid ' + COLORS.border,
                  background: 'var(--dsw-alias-button-elevated-fill, transparent)',
                  color: COLORS.text,
                  cursor: pinnedChoice === '' ? 'default' : 'pointer',
                  opacity: pinnedChoice === '' ? 0.6 : 1,
                  fontSize: 12
                }
              },
              t('pin')
            ),
            preference.provider
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => applyPinned(''),
                    style: {
                      padding: '7px 14px',
                      borderRadius: 8,
                      border: '1px solid ' + COLORS.border,
                      background: 'transparent',
                      color: COLORS.text,
                      cursor: 'pointer',
                      fontSize: 12
                    }
                  },
                  t('unpin')
                )
              : null,
            pinNotice ? h('span', { style: { color: COLORS.danger, fontSize: 12 } }, pinNotice) : null
          ),
          h(
            'div',
            { style: { fontSize: 11, color: COLORS.muted } },
            preference.provider
              ? t('pinned') + ': ' + preference.provider + (preference.model ? ' / ' + preference.model : '')
              : t('pinnedNone')
          ),
          planRows.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: COLORS.muted } },
                h('span', {}, t('planTitle') + ':'),
                planRows.slice(0, 5).map((row, index) =>
                  h(
                    'span',
                    { key: row.key, style: { fontFamily: 'var(--ds-font-family-code, monospace)' } },
                    (index + 1) + '. ' + row.key + '（' + row.cost + ' ' + row.health + '）'
                  )
                )
              )
            : null
        ),

        // 注册与签到清单
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '12px 16px',
              border: '1px solid ' + COLORS.border,
              borderRadius: 10
            }
          },
          h('h3', { style: { margin: 0, fontSize: 13, fontWeight: 600 } }, t('onboarding')),
          h('div', { style: { fontSize: 11, color: COLORS.muted } }, t('onboardingHint')),
          onboarding && (onboarding.groups || []).length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 11 } },
                onboarding.groups.map(group =>
                  h(
                    'div',
                    { key: group.provider, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                      h('span', { style: { fontWeight: 600, fontSize: 12 } }, group.name),
                      h(
                        'span',
                        {
                          style: {
                            color: group.active
                              ? COLORS.ok
                              : group.installed
                                ? COLORS.warn
                                : COLORS.muted
                          }
                        },
                        group.active
                          ? t('onboardActive')
                          : group.installed
                            ? t('onboardInstalled')
                            : t('onboardMissing')
                      ),
                      h('span', { style: { color: COLORS.muted } }, group.provider)
                    ),
                    group.items.map(item =>
                      h(
                        'div',
                        {
                          key: item.id,
                          style: {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                            paddingLeft: 8,
                            borderLeft: '2px solid ' + COLORS.border
                          }
                        },
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                          h(
                            'a',
                            {
                              href: item.claimUrl,
                              target: '_blank',
                              rel: 'noreferrer',
                              style: { color: COLORS.text, textDecoration: 'underline', fontSize: 12 }
                            },
                            item.title
                          ),
                          h('span', { style: { color: COLORS.muted } }, item.cadence),
                          item.cadence === 'daily' && item.how.indexOf('签到') !== -1
                            ? h('span', { style: { color: COLORS.warn } }, t('onboardDaily'))
                            : null
                        ),
                        h('span', { style: { color: COLORS.muted } }, item.amount),
                        h('span', { style: { color: COLORS.muted } }, item.how),
                        h(
                          'a',
                          {
                            href: item.apiKeyUrl,
                            target: '_blank',
                            rel: 'noreferrer',
                            style: { color: COLORS.text, textDecoration: 'underline', fontSize: 11 }
                          },
                          'API Key →'
                        )
                      )
                    )
                  )
                )
              )
            : h('div', { style: { fontSize: 12, color: COLORS.muted } }, t('quotaNone'))
        ),

        // 额度情报区块
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '12px 16px',
              border: '1px solid ' + COLORS.border,
              borderRadius: 10
            }
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('h3', { style: { margin: 0, fontSize: 13, fontWeight: 600 } }, t('quota')),
            quota && quota.status
              ? h(
                  'span',
                  { style: { fontSize: 11, color: COLORS.muted } },
                  t('quotaTotal') +
                    ' ' +
                    String(quota.status.total ?? 0) +
                    ' · ' +
                    t('quotaProviders') +
                    ' ' +
                    String(Object.keys(quota.providers ?? {}).length)
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                onClick: syncQuota,
                disabled: quotaSyncing,
                style: {
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid ' + COLORS.border,
                  background: 'transparent',
                  color: COLORS.text,
                  cursor: quotaSyncing ? 'default' : 'pointer',
                  opacity: quotaSyncing ? 0.6 : 1,
                  fontSize: 11
                }
              },
              quotaSyncing ? t('quotaSyncing') : t('quotaFetch')
            )
          ),
          h('div', { style: { fontSize: 11, color: COLORS.muted } }, t('quotaHint')),
          quota && Object.keys(quota.providers ?? {}).length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 } },
                Object.entries(quota.providers ?? {})
                  .sort((a, b) => {
                    const ua = a[1].hasUsableQuota ? 1 : 0
                    const ub = b[1].hasUsableQuota ? 1 : 0
                    if (ua !== ub) return ub - ua
                    return a[0].localeCompare(b[0])
                  })
                  .map(([id, info]) =>
                    h(
                      'div',
                      {
                        key: id,
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '3px 0'
                        }
                      },
                      h(
                        'span',
                        {
                          style: {
                            fontFamily: 'var(--ds-font-family-code, monospace)',
                            minWidth: 120
                          }
                        },
                        id
                      ),
                      h(
                        'span',
                        {
                          style: {
                            color: info.hasUsableQuota
                              ? COLORS.ok
                              : info.expired
                                ? COLORS.danger
                                : COLORS.muted
                          }
                        },
                        info.hasUsableQuota ? t('quotaUsable') : info.expired ? t('quotaExpired') : '—'
                      ),
                      h(
                        'span',
                        { style: { color: COLORS.muted } },
                        info.nextDeadline
                          ? new Date(info.nextDeadline).toISOString().slice(0, 10)
                          : ''
                      ),
                      info.claimUrls && info.claimUrls.length > 0
                        ? h(
                            'a',
                            {
                              href: info.claimUrls[0],
                              target: '_blank',
                              rel: 'noreferrer',
                              style: { color: COLORS.text, textDecoration: 'underline' }
                            },
                            t('quotaClaim')
                          )
                        : null
                    )
                  )
              )
            : h('div', { style: { fontSize: 12, color: COLORS.muted } }, t('quotaNone'))
        ),

        data &&
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h('h3', { style: { margin: 0, fontSize: 13, fontWeight: 600 } }, t('blocked')),
            blocked.length === 0
              ? h('div', { style: { fontSize: 12, color: COLORS.muted } }, t('noBlocked'))
              : blocked.map(entry =>
                  h(Row, {
                    key: entry.key,
                    entry,
                    t,
                    onProbe: probeRow,
                    probing: probingKey === entry.key,
                    notice: rowNotices[entry.key]
                  })
                )
          )
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'model-autopilot: dictionaries')
      const t = ctx.locale.bind(NS)

      // 面板内容：main 插槽里 key 与 panellist 的 id 同名，点击入口后由 layout 渲染。
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel)
      )

      // 左侧栏入口。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            locale: NS,
            label: () => t('panel')
          },
          AutopilotIcon
        )
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.PANEL_ID = PANEL_ID
    return module.exports
  }
})
