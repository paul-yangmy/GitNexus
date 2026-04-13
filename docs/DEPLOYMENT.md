# GitNexus Platform — 部署与测试手册

> 适用版本：SQLite 单进程版（无需 PostgreSQL、Redis 或 MinIO）

---

## 目录

1. [架构概览](#架构概览)
2. [本地开发启动](#本地开发启动)
3. [Docker 部署](#docker-部署)
4. [环境变量参考](#环境变量参考)
5. [首次登录与账号管理](#首次登录与账号管理)
6. [API 快速测试（curl）](#api-快速测试)
7. [常见问题排查](#常见问题排查)

---

## 架构概览

```
本地 / Docker 容器
┌─────────────────────────────────────────┐
│  Node.js 进程 (gitnexus serve)          │
│                                         │
│  ┌─────────┐   ┌────────────────────┐   │
│  │ Express │   │ In-process Queue   │   │
│  │  API    │──▶│ (EventEmitter)     │   │
│  └─────────┘   │  analyzeQueue x1   │   │
│                │  wikiQueue    x2   │   │
│  ┌─────────┐   └────────────────────┘   │
│  │  SSE    │                            │
│  │ /progress│                           │
│  └─────────┘                            │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │  SQLite  (better-sqlite3)        │   │
│  │  默认路径: <cwd>/platform.db     │   │
│  │  Docker:  /data/platform.db      │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

- 分析任务/Wiki 生成均在**同一进程**内运行，无需独立 worker 容器。
- 任务进度通过 **in-process EventEmitter** 发布，前端通过 SSE 订阅。
- 数据库为 **SQLite**（WAL 模式），文件持久化在主机目录中。

---

## 本地开发启动

### 前置要求

| 工具 | 版本要求 |
|------|---------|
| Node.js | ≥ 20 |
| npm | ≥ 10 |

### 步骤

```bash
# 1. 进入主包目录并安装依赖
cd gitnexus
npm install

# 2. 编译 TypeScript
npm run build

# 3. 启动服务（SQLite 数据库自动创建）
npm run serve
# 等价于: node dist/cli/index.js serve
```

**默认监听地址：** http://localhost:4747

**SQLite 数据库路径：** `<项目根目录>/platform.db`（自动创建）

### 自定义配置（可选）

```bash
# 指定数据库路径
PLATFORM_DB_PATH=/tmp/my-gitnexus.db npm run serve

# 指定 JWT 密钥（生产环境务必修改）
JWT_SECRET=my_very_long_random_secret npm run serve

# 指定监听端口
PORT=8080 npm run serve

# 指定管理员账号（仅首次启动有效）
PLATFORM_ADMIN_USERNAME=myadmin PLATFORM_ADMIN_PASSWORD=mypassword npm run serve
```

---

## Docker 部署

### 前置要求

- Docker Engine ≥ 24
- Docker Compose v2

### 快速启动

```bash
# 在项目根目录执行
cd d:/project/GitNexus   # 或你的项目路径

# 1. 创建数据目录（自动映射到容器 /data）
mkdir -p data

# 2. （推荐）创建 .env 文件，覆盖默认值
cat > .env << 'EOF'
JWT_SECRET=请替换为随机长字符串
PLATFORM_ADMIN_PASSWORD=请修改默认密码
REPOS_PATH=D:/my-repos   # 可选：映射本地仓库目录
PORT=4747
EOF

# 3. 构建并启动
docker compose -f docker-compose.platform.yml up -d

# 4. 查看日志
docker compose -f docker-compose.platform.yml logs -f
```

**访问地址：** http://localhost:4747

**数据库文件位置（主机）：** `./data/platform.db`

### 更新/重启

```bash
# 停止并重建（数据库不会丢失）
docker compose -f docker-compose.platform.yml down
docker compose -f docker-compose.platform.yml build --no-cache
docker compose -f docker-compose.platform.yml up -d
```

### 备份数据库

```bash
# 热备份（SQLite WAL 模式安全）
cp data/platform.db data/platform.db.bak
```

---

## 环境变量参考

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PLATFORM_DB_PATH` | `<cwd>/platform.db` | SQLite 数据库文件路径 |
| `JWT_SECRET` | `gitnexus_jwt_dev_secret_change_me` | JWT 签名密钥，**生产务必修改** |
| `PLATFORM_ADMIN_USERNAME` | `admin` | 初始管理员用户名（仅首次启动生效） |
| `PLATFORM_ADMIN_PASSWORD` | `admin123` | 初始管理员密码（仅首次启动生效，**务必修改**） |
| `PORT` | `4747` | HTTP 监听端口 |
| `HOST` | `127.0.0.1` | HTTP 监听地址（Docker 中设为 `0.0.0.0`） |
| `NODE_ENV` | `development` | 运行环境 |
| `REPOS_PATH` | `./repos` | Docker 中映射宿主机仓库目录（只读） |

---

## 首次登录与账号管理

### 默认管理员账号

首次启动时自动创建：
- 用户名：`admin`（或 `PLATFORM_ADMIN_USERNAME`）
- 密码：`admin123`（或 `PLATFORM_ADMIN_PASSWORD`）

### 获取 JWT Token（登录）

```bash
curl -s -X POST http://localhost:4747/api/platform/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq .
```

响应示例：
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { "id": "...", "username": "admin", "role": "admin" }
}
```

将 token 保存为变量：
```bash
TOKEN=$(curl -s -X POST http://localhost:4747/api/platform/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq -r .token)
```

### 注册普通用户

```bash
curl -s -X POST http://localhost:4747/api/platform/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"dev1","password":"dev1pass","displayName":"Developer 1"}' | jq .
```

---

## API 快速测试

> 以下示例假设 `TOKEN` 变量已设置（见上方登录步骤）

### 健康检查

```bash
curl http://localhost:4747/health
# 期望响应: {"status":"ok"}
```

### 创建项目

```bash
curl -s -X POST http://localhost:4747/api/platform/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "my-repo",
    "source_type": "git",
    "source_url": "https://github.com/example/repo.git"
  }' | jq .
```

### 列出所有项目

```bash
curl -s http://localhost:4747/api/platform/projects \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 触发分析任务

```bash
PROJECT_ID="<上一步返回的 id>"

curl -s -X POST "http://localhost:4747/api/platform/projects/$PROJECT_ID/analyze" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 查询任务状态

```bash
JOB_ID="<上一步返回的 jobId>"

curl -s "http://localhost:4747/api/platform/projects/$PROJECT_ID/jobs/$JOB_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 实时进度订阅（SSE）

```bash
curl -N "http://localhost:4747/api/platform/projects/$PROJECT_ID/jobs/$JOB_ID/progress" \
  -H "Authorization: Bearer $TOKEN"
```

### 触发 Wiki 生成

```bash
curl -s -X POST "http://localhost:4747/api/platform/projects/$PROJECT_ID/wiki" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 查看当前登录用户信息

```bash
curl -s http://localhost:4747/api/platform/auth/me \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 常见问题排查

### 启动时报错：`ENOENT: no such file or directory`（数据库路径）

确保 `PLATFORM_DB_PATH` 指向的**目录**已存在。代码会自动创建目录，但如果路径中包含无权限的系统目录则会失败。

```bash
mkdir -p "$(dirname "$PLATFORM_DB_PATH")"
```

### JWT Token 过期或无效

Token 有效期为 24 小时，重新登录获取新 Token。

如果报 `invalid signature`，确保所有实例使用相同的 `JWT_SECRET`。

### Docker 容器无法访问外部 Git 仓库

容器内执行克隆需要网络访问权限，确保 Docker 网络配置正确（一般默认即可）。

对于私有仓库，可在 `docker-compose.platform.yml` 的 environment 中传入 `GIT_TOKEN` 等凭据。

### 分析任务卡在 "queued" 状态

in-process 队列在服务进程内运行，无需单独启动 worker。检查服务日志：

```bash
# 本地
npm run serve 2>&1 | grep -E 'worker|queue|error'

# Docker
docker compose -f docker-compose.platform.yml logs gitnexus | grep -E 'worker|queue|error'
```

### 查看数据库内容（调试用）

```bash
# 安装 sqlite3 CLI（如未安装）
# macOS: brew install sqlite
# Ubuntu: apt install sqlite3
# Windows: choco install sqlite

sqlite3 data/platform.db ".tables"
sqlite3 data/platform.db "SELECT * FROM analyze_jobs ORDER BY created_at DESC LIMIT 5;"
```
