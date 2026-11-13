# 移动中继连接与实例接管

## 配对与连接归属

- `relay/src/room.ts` 的 `PairRoom` 每种角色保留一个 WebSocket；同角色新连接使旧连接收到 `1000 / replaced`。
- 桌面 `src/relay_host.rs` 收到该信号后将设备标为 `replaced`，停止该连接所有者的自动重试，保留配对凭据和最新备注。设置页显示“已被接管”，用户可点击“在此接管”。
- `relay_resume_device` 与备注、撤销共用凭据锁，接管前重新读取所属系统凭据记录，承接其他实例已保存的备注并检查撤销/身份变化；只为被接管的永久设备创建新的连接所有者，旧任务保持停止。连接中或正常设备的重复调用为空操作，撤销设备拒绝接管。临时分享保留独立、限时的授权范围。
- `src/relay_socket.rs` 将读取、顺序 RPC 和网络发送分开推进，关闭帧优先于同时就绪的心跳/发送失败。耗时 RPC 和发送阻塞期间继续读取接管信号；有界队列和单一消费者保持终端输入、文件保存等写请求的顺序，旧手机连接排队的请求按 channel 丢弃。
- `1008` 或 `revoked` 控制消息停止连接；一般断线采用 1、2、4、8、16、30 秒的退避。仅持续连接至少 30 秒后重置退避，短暂正常关闭也累计失败次数。
- 手机浏览器和 Android 服务同样在被替换后停止自动抢连。桌面设置页每秒的 `relay_status` 是本地 IPC；云端邀请轮询由用户创建配对/临时分享触发。

## 调试与正式版隔离

| 范围 | 系统凭据库 service | 地址配置（`~/.coffee-cli/`） | 默认中继 |
| --- | --- | --- | --- |
| 正式构建 | `coffee-cli` | `relay-url` | `https://sinos-relay.zhlhopefil.workers.dev` |
| 调试构建（`debug_assertions`） | `coffee-cli-debug` | `relay-url-debug` | `http://127.0.0.1:8788` |

两个范围的 account 格式均为 `paired-mobile-devices` 和 `mobile-{pair_id}`；正式版历史标识保持兼容。所有加载、保存、备注及撤销路径使用所属范围，调试启动只恢复调试配对。用户可显式设置测试中继地址。前端等待后端返回范围后才允许创建配对，初始状态不预填生产服务。

正式版仍自动连接已保存设备，以便手机随时接续。实例接管停止当前进程内的连接所有者；重新启动程序会重新加载其范围内的配对。

## 验证入口

- 远程 `cargo test --locked --no-fail-fast`：关闭分类、退避重置、接管所有者、跨实例备注/撤销和范围兼容回归；`relay_socket_tests.rs` 在受控传输/RPC 边界运行生产循环，覆盖阻塞 RPC、阻塞/失败发送时的接管和写请求顺序。
- `npm test --prefix src-ui`、`npm run test:browser --prefix src-ui`：加载范围、被接管状态、显式接管、忙碌/失败恢复和状态轮询检查。
- `npm run typecheck --prefix relay`、`npm test --prefix relay`；本地 Workers 运行后执行 `RELAY_TEST_URL=http://127.0.0.1:<port> npm run test:integration --prefix relay`，使用一次性凭据验证真实关闭信号、加密交接、撤销及临时分享。
- 本地服务使用 `wrangler dev --local`、loopback 和独立 `--persist-to`；过程文件放 `.Sinos-temp/`。原生验证与五平台构建按[发布规则](release.md)在 GitHub Actions 执行。
