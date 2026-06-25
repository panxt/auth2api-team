# auth2api 路线图(Roadmap)

本文档记录 `auth2api-team`(fork)在当前版本(v2.2.0,自适应加权并发负载均衡)之后的功能规划方向。仅为方向性规划,具体设计与优先级以实际排期为准。

> 文档定位:团队共享的功能方向备忘;当前架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md),运维见 [`OPERATIONS.md`](OPERATIONS.md)。

---

## 规划项

### 1. 各平台 API 兜底(fallback)

接入各平台的**官方 API key 通道**作为兜底:当 OAuth 订阅账号访问异常(限流 / 冷却 / 账号池全部不可用)时,自动切换到官方 API 调用,保证服务可用性。

- **定位**:作为账号池调度失败后的**最后一层 fallback**,而非替代账号池——优先用订阅账号(成本优势),仅在订阅侧不可用时才兜到按量计费的 API。
- **衔接现状**:与 v2.2.0 的账号池调度 / 容量告警体系对接——当 `capacitySummary` 判定账号池饱和或全挂时,由 API 兜底兜住请求,而不是直接对客户端返回 429。
- **复用点**:现有 provider registry 与 failover 抽象。

### 2. 支持国内各类模型 + 自部署模型

扩展现有 provider 体系(当前:anthropic / codex / cursor),纳入更多模型来源:

- **国内主流模型**:如通义千问、智谱 GLM、DeepSeek 等。
- **自部署 / 私有模型**:本地 vLLM、Ollama 等 OpenAI 兼容端点。
- **复用点**:多数目标具备 OpenAI 兼容接口,优先复用现有翻译层与 provider 注册机制,新增 provider 适配而非另起炉灶。

### 3. 多模态支持

在转发 / 翻译层(`translator` / `responses-translator`)支持**多模态输入**(图像等),不再局限于纯文本。

- **范围**:请求侧的图像 / 文件等多模态内容透传与协议翻译;跨 provider 的多模态能力差异需做能力探测或降级处理。

---

> 维护:有新方向请在此追加;某项进入实现阶段后,在对应条目标注关联的分支 / PR / 版本。
