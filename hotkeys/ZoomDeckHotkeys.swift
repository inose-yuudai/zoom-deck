// Zoom Deck の全体ショートカット（どのアプリを操作中でも効く）
//
//   ⌃⌥M マイク / ⌃⌥B 音楽 / ⌃⌥V 仮想カメラ / ⌃⌥R 離席（アニメだけ）/ ⌃⌥T CM を流して離席
//   ⌃⌥A アバター / ⌃⌥C 実カメラ / ⌃⌥1〜9 表情 / ⌃⌥0 表情解除
//   ⌃⌥P YouTube 再生/一時停止 / ⌃⌥N 次の曲
//
// Carbon の RegisterEventHotKey を使うので、アクセシビリティや入力監視の許可は不要。
// 押すとローカルサーバー（Avatar Cam / Zoom Deck）に操作を送り、画面下に結果を小さく表示する。
// ビルド: swiftc -O ZoomDeckHotkeys.swift -o ../bin/zoom-deck-hotkeys
import Carbon.HIToolbox
import Cocoa

let server = URL(string: "http://127.0.0.1:18787")!
let modifiers = UInt32(controlKey | optionKey)

struct Shortcut {
    let keyCode: Int
    let key: String
    let body: [String: Any]
}

let digitKeys = [kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4, kVK_ANSI_5, kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9]

let shortcuts: [Shortcut] = [
    Shortcut(keyCode: kVK_ANSI_M, key: "M", body: ["action": "mic"]),
    Shortcut(keyCode: kVK_ANSI_B, key: "B", body: ["action": "music"]),
    Shortcut(keyCode: kVK_ANSI_V, key: "V", body: ["action": "vcam"]),
    Shortcut(keyCode: kVK_ANSI_R, key: "R", body: ["action": "brb"]),
    Shortcut(keyCode: kVK_ANSI_T, key: "T", body: ["action": "brb", "withCm": true]),
    Shortcut(keyCode: kVK_ANSI_A, key: "A", body: ["action": "view", "view": "avatar"]),
    Shortcut(keyCode: kVK_ANSI_C, key: "C", body: ["action": "view", "view": "camera"]),
    Shortcut(keyCode: kVK_ANSI_0, key: "0", body: ["action": "expression", "index": -1]),
    Shortcut(keyCode: kVK_ANSI_P, key: "P", body: ["action": "yt", "command": "toggle"]),
    Shortcut(keyCode: kVK_ANSI_N, key: "N", body: ["action": "yt", "command": "next"]),
] + digitKeys.enumerated().map { i, code in
    Shortcut(keyCode: code, key: "\(i + 1)", body: ["action": "expression", "index": i])
}

// VRM の表情名は英語なので日本語にする（ボタン盤と同じ）
let expressionLabels = ["happy": "笑顔", "angry": "怒り", "sad": "悲しい", "surprised": "驚き", "relaxed": "リラックス"]

// MARK: - 画面下に出す小さな表示（音量 HUD のようなもの）

final class HUD {
    private let panel: NSPanel
    private let label = NSTextField(labelWithString: "")
    private var hideWork: DispatchWorkItem?

    init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 56),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.ignoresMouseEvents = true
        panel.hasShadow = true
        // フルスクリーンの Zoom の上にも出す
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

        let effect = NSVisualEffectView(frame: panel.contentView!.bounds)
        effect.material = .hudWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 14
        effect.autoresizingMask = [.width, .height]

        label.font = .systemFont(ofSize: 17, weight: .semibold)
        label.textColor = .white
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: effect.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: effect.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: effect.leadingAnchor, constant: 16),
        ])
        panel.contentView = effect
    }

    func show(_ text: String) {
        label.stringValue = text
        let width = max(220, label.intrinsicContentSize.width + 48)
        // マウスのある画面に出す（外部ディスプレイ使用時も見える場所に）
        let mouse = NSEvent.mouseLocation
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrame(NSRect(x: f.midX - width / 2, y: f.minY + 90, width: width, height: 56), display: true)
        }
        hideWork?.cancel()
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        let work = DispatchWorkItem { [weak self] in
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.25
                self?.panel.animator().alphaValue = 0
            }, completionHandler: { self?.panel.orderOut(nil) })
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3, execute: work)
    }
}

let hud = HUD()

// MARK: - サーバーへの送信

func request(_ path: String, body: [String: Any]? = nil, completion: @escaping ([String: Any]?) -> Void) {
    var req = URLRequest(url: server.appendingPathComponent(path), timeoutInterval: 3)
    if let body {
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    URLSession.shared.dataTask(with: req) { data, response, _ in
        let ok = (response as? HTTPURLResponse).map { $0.statusCode < 400 } ?? false
        let json = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
        completion(ok ? (json ?? [:]) : nil)
    }.resume()
}

func describe(_ body: [String: Any], _ st: [String: Any]) -> String {
    let mic = st["mic"] as? [String: Any]
    let music = st["music"] as? [String: Any]
    let avatar = st["avatar"] as? [String: Any]
    switch body["action"] as? String {
    case "mic": return (mic?["muted"] as? Bool ?? false) ? "🎤 マイク ミュート" : "🎤 マイク ON"
    case "music": return (music?["muted"] as? Bool ?? false) ? "♪ 音楽 停止" : "♪ 音楽 再生"
    case "vcam": return (st["vcam"] as? Bool ?? false) ? "● 仮想カメラ 開始" : "○ 仮想カメラ 停止"
    case "brb":
        guard st["brb"] as? Bool ?? false else { return "おかえりなさい（離席を終了）" }
        return (body["withCm"] as? Bool ?? false) && st["cm"] is [String: Any] ? "🎬 CM → 離席中（マイク OFF）" : "☕ 離席中（マイク OFF）"
    case "view": return (st["view"] as? String) == "camera" ? "📷 実カメラを表示" : "🧑 アバターを表示"
    case "yt":
        let yt = st["youtube"] as? [String: Any]
        let title = (yt?["title"] as? String).map { "：\($0.prefix(24))" } ?? ""
        if (body["command"] as? String) == "next" { return "⏭ 次の曲\(title)" }
        return (yt?["playing"] as? Bool ?? false) ? "▶︎ 再生\(title)" : "⏸ 一時停止"
    case "expression":
        let index = body["index"] as? Int ?? -1
        let names = avatar?["expressions"] as? [String] ?? []
        if index < 0 { return "表情を解除" }
        guard index < names.count else { return "表情 \(index + 1) はありません" }
        return "表情: \(expressionLabels[names[index]] ?? names[index])"
    default: return ""
    }
}

func trigger(_ shortcut: Shortcut) {
    request("api/deck/action", body: shortcut.body) { result in
        guard result != nil else {
            let text = shortcut.body["action"] as? String == "yt" ? "⚠︎ YouTube のタブが見つかりません" : "⚠︎ Zoom Deck に接続できません"
            DispatchQueue.main.async { hud.show(text) }
            return
        }
        if (result?["delivered"] as? Int) == 0 {
            DispatchQueue.main.async { hud.show("⚠︎ アバターの画面が開いていません") }
            return
        }
        // 表情は画面側の反映を少し待ってから状態を読む
        let action = shortcut.body["action"] as? String
        let delay: Double = action == "expression" ? 1.2 : action == "yt" ? 1.5 : 0.15
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) {
            request("api/deck/state") { st in
                let text = st.map { describe(shortcut.body, $0) } ?? "⚠︎ 状態を取得できません"
                DispatchQueue.main.async { hud.show(text) }
            }
        }
    }
}

// MARK: - ホットキー登録

let handler: EventHandlerUPP = { _, event, _ in
    var id = EventHotKeyID()
    GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                      nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
    let index = Int(id.id)
    if index < shortcuts.count { trigger(shortcuts[index]) }
    return noErr
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), handler, 1, &eventType, nil, nil)

var refs: [EventHotKeyRef?] = []
var failed: [String] = []
for (i, s) in shortcuts.enumerated() {
    var ref: EventHotKeyRef?
    let status = RegisterEventHotKey(UInt32(s.keyCode), modifiers, EventHotKeyID(signature: OSType(0x5A44_4B31), id: UInt32(i)),
                                     GetApplicationEventTarget(), 0, &ref)
    if status == noErr { refs.append(ref) } else { failed.append("⌃⌥\(s.key)") }
}
print("Zoom Deck ショートカット: \(shortcuts.count - failed.count) 個を登録" + (failed.isEmpty ? "" : "（他のアプリと重複して使えない: \(failed.joined(separator: ", "))）"))
fflush(stdout)

app.run()
