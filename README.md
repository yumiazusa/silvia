# 财务会计实训平台（Silvia）

这是可部署到 Ubuntu 服务器的独立 Node.js 项目。Node 同时提供页面和 API，数据保存在服务器的 `data.json`。项目只使用 Node 内置模块，要求 Node.js 18+，无需 `npm install`。

本仓库是新班级版本：**不包含旧学生、旧业务题、旧成绩或教师账号数据**。空数据启动后自动生成 8 个模块和 2 张标准报表；业务题由教师录入。学生首次使用班级、姓名、学号登录时自动建档。教师密码按原有 scrypt 方式验证，不在仓库保存明文或哈希。

## Ubuntu + 宝塔部署

以下假设宝塔和 Node 安装在 Ubuntu **宿主机**。先确认 `node -v` 显示 18 或更高版本，并用 `command -v node` 查到 Node 的绝对路径。如果 Node 只装在宝塔 Docker 容器内，应改用容器内进程管理和持久化卷，不能直接套用下面的 systemd 服务。

1. 用有 GitHub SSH 权限的账号拉代码：

   ```bash
   git clone git@github.com:yumiazusa/silvia.git /opt/silvia
   cd /opt/silvia
   git status --short
   node -v
   command -v node
   ```

2. 建独立运行用户和数据目录。数据目录位于网站根目录之外：

   ```bash
   sudo useradd --system --home /var/lib/silvia --shell /usr/sbin/nologin silvia
   sudo install -d -o silvia -g silvia -m 700 /var/lib/silvia
   ```

   如果提示用户已存在，继续执行第二行即可。

3. **开通公网前**，在服务器终端初始化教师账号。输入当前教师手机号和**原密码**，保持现有登录凭据。密码输入时不显示；不要把密码写进命令、环境变量或 Git。将下方 `/usr/bin/node` 替换为 `command -v node` 的实际结果：

   ```bash
   sudo -u silvia env DATA_DIR=/var/lib/silvia /usr/bin/node /opt/silvia/scripts/init-teacher.js
   sudo ls -l /var/lib/silvia/data.json
   ```

   若账号已存在，脚本会拒绝覆盖。没有教师账号时服务也会拒绝启动，防止网页访客抢先注册管理员。

4. 建 systemd 服务。先打开 [deploy/silvia.service.example](deploy/silvia.service.example)，将 `ExecStart` 的 Node 路径改成服务器实际路径，再执行：

   ```bash
   sudo cp /opt/silvia/deploy/silvia.service.example /etc/systemd/system/silvia.service
   sudo nano /etc/systemd/system/silvia.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now silvia
   sudo systemctl status silvia
   curl -I http://127.0.0.1:3000/
   ```

   默认只监听 `127.0.0.1:3000`，不要在阿里云安全组中开放 3000。若 3000 已被别的服务占用，修改 service 中的 `PORT`，宝塔反向代理目标也要同步更改。

5. 在阿里云将域名解析到服务器公网 IP，安全组放通 TCP 80/443。在宝塔添加该域名的网站，设置反向代理到 `http://127.0.0.1:3000`，申请并启用 HTTPS 证书，开启 HTTP 跳转 HTTPS。网站根目录不指向 `/var/lib/silvia`。完成后浏览器访问域名，用教师账号登录。中国内地服务器使用域名时还需按接入要求完成备案。

## 更新和备份

代码更新不会覆盖 `data.json`，因为数据不在 Git 仓库：

```bash
sudo cp -p /var/lib/silvia/data.json /var/lib/silvia/data-before-update-$(date +%Y%m%d-%H%M%S).json
cd /opt/silvia
git pull --ff-only origin main
sudo systemctl restart silvia
sudo journalctl -u silvia -n 50 --no-pager
```

定期把 `/var/lib/silvia/data.json` 另存到**另一块磁盘或异地存储**，并验证备份可读取。程序维护的 `data_backup.json` 只是同目录即时副本，不能替代异地备份。恢复时先停止服务，将备份复制为 `data.json`、设为 `silvia:silvia` 和 `600` 权限，再启动。

## 本地开发与检查

先运行 `node scripts/init-teacher.js`，再运行 `node server.js`。本地数据默认在项目下的 `data/`，已被 Git 忽略。设置 `DATA_DIR` 可指定独立数据目录；`HOST` 默认 `127.0.0.1`，`PORT` 默认 `3000`。运行 `node scripts/smoke-test.js` 会在临时目录测试，不修改真实教师数据。

注意：学生端仍以班级、姓名、学号识别身份，知道这些信息的人可能冒用学生身份。公网开课前，教师应评估是否需要增加学生密码或一次性邀请码。当前版本适合先完成迁移和试运行。
