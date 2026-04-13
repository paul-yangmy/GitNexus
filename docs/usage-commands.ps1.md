# GitNexus 使用命令

## 根目录可用命令

```powershell
cd D:\project\GitNexus
npm run format
npm run format:check
npm run lint
npm run lint:fix
```

## 安装依赖

```powershell
cd D:\project\GitNexus\gitnexus
npm install
```

```powershell
cd D:\project\GitNexus\gitnexus-web
npm install
```

## 启动后端

```powershell
cd D:\project\GitNexus\gitnexus
npm run serve
```

## 启动后端开发监听

```powershell
cd D:\project\GitNexus\gitnexus
npm run dev
```

## 构建后端

```powershell
cd D:\project\GitNexus\gitnexus
npm run build
```

## 启动前端

```powershell
cd D:\project\GitNexus\gitnexus-web
npm run dev
```

## 构建前端

```powershell
cd D:\project\GitNexus\gitnexus-web
npm run build
```

## 前端测试

```powershell
cd D:\project\GitNexus\gitnexus-web
npm test
```

## 后端类型检查

```powershell
cd D:\project\GitNexus\gitnexus
npx tsc --noEmit
```

## 前端类型检查

```powershell
cd D:\project\GitNexus\gitnexus-web
npx tsc -b --noEmit
```

## 常用 GitNexus 命令

```powershell
cd D:\project\GitNexus\gitnexus
npx gitnexus analyze
npx gitnexus analyze --force
npx gitnexus serve
npx gitnexus list
npx gitnexus status
npx gitnexus wiki
```

## 最小启动流程

```powershell
cd D:\project\GitNexus\gitnexus
npm install
npm run serve
```

```powershell
cd D:\project\GitNexus\gitnexus-web
npm install
npm run dev
```

## 最小验证流程

```powershell
cd D:\project\GitNexus\gitnexus
npm run build
npx tsc --noEmit
```

```powershell
cd D:\project\GitNexus\gitnexus-web
npm run build
npx tsc -b --noEmit
npm test
```
