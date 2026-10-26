# `claude-profiles` MVP

## Mục tiêu

Chạy nhiều Claude Code subscription trên một máy, chọn profile thủ công khi
chạm usage window, nhưng mỗi phiên Claude TUI phải vào thẳng account đã chọn —
không hiện login selector.

## Phạm vi

- Source: `.orchestrator/projects/claude-profiles`
- Runtime: Node.js, không thêm dependency ngoài Node built-in.
- Bản cài global cung cấp lệnh `claude-profiles`.
- Không dùng hoặc sao chép code từ tool bên thứ ba.

## CLI

```sh
claude-profiles add <profile>
claude-profiles list
claude-profiles status [profile]
claude-profiles use <profile> [-- <claude arguments>]
claude-profiles refresh <profile>
claude-profiles remove <profile>
```

Ví dụ:

```sh
claude-profiles add mep
claude-profiles add uplive
claude-profiles list
claude-profiles use mep
claude-profiles use uplive -- --resume
claude-profiles refresh mep
```

`use` phải `exec` Claude Code thật, không chạy qua một wrapper TUI khác.

## Luồng `add` / `refresh`

1. Tool chạy `claude setup-token` với các biến auth cạnh tranh đã bị loại khỏi
   environment.
2. Người dùng tự duyệt browser và chọn đúng account.
3. Người dùng dán setup token vào terminal local; tuyệt đối không đưa token vào
   chat, file config, log, hay shell history.
4. Tool lưu token vào macOS Keychain, service riêng theo profile:

   ```text
   Claude Profiles: <profile>
   ```

5. Registry chỉ lưu tên profile và Keychain service, không lưu token.

## Luồng `use`

1. Đọc token của profile từ Keychain.
2. Tạo hoặc refresh config riêng:

   ```text
   ~/.config/claude-profiles/configs/<profile>/
   ```

3. Share bằng symlink các phần không-auth từ config Claude gốc: settings,
   skills, plugins, commands, hooks, history cần thiết.
4. Không share runtime files: daemon, lock, socket.
5. Tạo `.claude.json` riêng cho profile bằng bản sao từ base nhưng bỏ top-level
   key `oauthAccount`.
6. Xóa các biến auth/provider có thể ghi đè account:

   - `ANTHROPIC_API_KEY`
   - `ANTHROPIC_AUTH_TOKEN`
   - `ANTHROPIC_BASE_URL`
   - Bedrock / Vertex / Foundry flags
   - `CLAUDE_CODE_OAUTH_TOKEN` có sẵn từ shell

7. Launch Claude với:

   ```sh
   CLAUDE_CODE_OAUTH_TOKEN=<token>
   CLAUDE_CONFIG_DIR=<profile-config-dir>
   claude <arguments>
   ```

Nếu Keychain hoặc config isolation lỗi, command phải fail; không được fallback
sang Claude không-isolated.

## Bảo mật

- Keychain: `/usr/bin/security` với generic-password, service riêng mỗi
  profile.
- Registry file: mode `0600`; config directories: `0700`.
- Không in token trong output/error.
- `remove` hỏi xác nhận, rồi xóa đúng Keychain item và registry entry.
- `refresh` thay token Keychain atomically; không lưu token cũ.

## Acceptance checklist

- [ ] `add mep` và `add uplive` hoàn tất bằng browser auth, không lộ token.
- [ ] `status mep` / `status uplive` báo profile có token, không in token.
- [ ] `use mep` mở Claude TUI trực tiếp, không hiện màn hình login.
- [ ] Trong TUI, `auth status` xác nhận đúng identity của `mep`.
- [ ] Thoát; `use uplive` xác nhận identity khác và cũng không hiện login.
- [ ] Hai terminal chạy hai profile đồng thời không lẫn account.
- [ ] Settings/plugins/skills dùng chung vẫn hoạt động.
- [ ] `refresh mep` thay token thành công; `use mep` vẫn vào TUI trực tiếp.
- [ ] `remove mep` xóa đúng token/profile sau xác nhận.

Không coi `claude auth status` một mình là bằng chứng thành công; chỉ pass khi
Claude TUI thật mở không cần login và hiển thị đúng identity.
