// Zoom Deck のアプリアイコン（1024px PNG）を描く
// 使い方: swift MakeIcon.swift out.png
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"

let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext

// 背景：角丸の正方形に紺〜紫のグラデーション
let inset: CGFloat = 100
let bgRect = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let bg = NSBezierPath(roundedRect: bgRect, xRadius: 185, yRadius: 185)
ctx.saveGState()
bg.addClip()
NSGradient(colors: [NSColor(srgbRed: 0.16, green: 0.12, blue: 0.33, alpha: 1), NSColor(srgbRed: 0.07, green: 0.08, blue: 0.14, alpha: 1)])!
    .draw(in: bgRect, angle: -90)
ctx.restoreGState()

// ボタン（3 × 2）
let colors: [NSColor] = [
    NSColor(srgbRed: 0.18, green: 0.75, blue: 0.44, alpha: 1), // マイク
    NSColor(srgbRed: 0.24, green: 0.55, blue: 1.00, alpha: 1), // 音楽
    NSColor(srgbRed: 0.90, green: 0.28, blue: 0.30, alpha: 1), // カメラ
    NSColor(srgbRed: 0.95, green: 0.66, blue: 0.23, alpha: 1), // 離席
    NSColor(srgbRed: 0.68, green: 0.49, blue: 1.00, alpha: 1), // アバター
    NSColor(srgbRed: 1.00, green: 0.55, blue: 0.75, alpha: 1), // CM
]
let keySize: CGFloat = 214, gap: CGFloat = 38
let gridW = keySize * 3 + gap * 2, gridH = keySize * 2 + gap
let x0 = (size - gridW) / 2, y0 = (size - gridH) / 2

func glyph(_ i: Int, in r: CGRect) {
    NSColor.white.setFill()
    NSColor.white.setStroke()
    let c = CGPoint(x: r.midX, y: r.midY)
    let p = NSBezierPath()
    p.lineWidth = 14
    p.lineCapStyle = .round
    p.lineJoinStyle = .round
    switch i {
    case 0: // マイク
        NSBezierPath(roundedRect: CGRect(x: c.x - 24, y: c.y - 6, width: 48, height: 74), xRadius: 24, yRadius: 24).fill()
        p.appendArc(withCenter: CGPoint(x: c.x, y: c.y + 14), radius: 46, startAngle: 200, endAngle: 340)
        p.move(to: CGPoint(x: c.x, y: c.y - 32)); p.line(to: CGPoint(x: c.x, y: c.y - 58))
        p.stroke()
    case 1: // 音符
        NSBezierPath(ovalIn: CGRect(x: c.x - 58, y: c.y - 58, width: 44, height: 36)).fill()
        NSBezierPath(ovalIn: CGRect(x: c.x + 6, y: c.y - 44, width: 44, height: 36)).fill()
        p.move(to: CGPoint(x: c.x - 18, y: c.y - 40)); p.line(to: CGPoint(x: c.x - 18, y: c.y + 52))
        p.line(to: CGPoint(x: c.x + 46, y: c.y + 64)); p.line(to: CGPoint(x: c.x + 46, y: c.y - 26))
        p.stroke()
    case 2: // ビデオカメラ
        NSBezierPath(roundedRect: CGRect(x: c.x - 66, y: c.y - 38, width: 88, height: 76), xRadius: 14, yRadius: 14).fill()
        let t = NSBezierPath()
        t.move(to: CGPoint(x: c.x + 28, y: c.y)); t.line(to: CGPoint(x: c.x + 66, y: c.y + 30)); t.line(to: CGPoint(x: c.x + 66, y: c.y - 30)); t.close()
        t.fill()
    case 3: // コーヒーカップ
        NSBezierPath(roundedRect: CGRect(x: c.x - 56, y: c.y - 52, width: 88, height: 80), xRadius: 22, yRadius: 22).fill()
        p.appendArc(withCenter: CGPoint(x: c.x + 38, y: c.y - 10), radius: 22, startAngle: -90, endAngle: 90)
        for dx in [-34.0, -12.0, 10.0] {
            p.move(to: CGPoint(x: c.x + dx, y: c.y + 44)); p.curve(to: CGPoint(x: c.x + dx, y: c.y + 76), controlPoint1: CGPoint(x: c.x + dx + 14, y: c.y + 56), controlPoint2: CGPoint(x: c.x + dx - 14, y: c.y + 64))
        }
        p.stroke()
    case 4: // アバター（にっこり顔）
        p.appendOval(in: CGRect(x: c.x - 60, y: c.y - 60, width: 120, height: 120))
        p.stroke()
        NSBezierPath(ovalIn: CGRect(x: c.x - 30, y: c.y + 8, width: 16, height: 20)).fill()
        NSBezierPath(ovalIn: CGRect(x: c.x + 14, y: c.y + 8, width: 16, height: 20)).fill()
        let m = NSBezierPath(); m.lineWidth = 12; m.lineCapStyle = .round
        m.appendArc(withCenter: CGPoint(x: c.x, y: c.y - 6), radius: 30, startAngle: 210, endAngle: 330)
        m.stroke()
    default: // 再生（CM）
        let t = NSBezierPath()
        t.move(to: CGPoint(x: c.x - 34, y: c.y - 50)); t.line(to: CGPoint(x: c.x + 54, y: c.y)); t.line(to: CGPoint(x: c.x - 34, y: c.y + 50)); t.close()
        t.fill()
    }
}

for i in 0..<6 {
    let col = i % 3, row = 1 - i / 3
    let r = CGRect(x: x0 + CGFloat(col) * (keySize + gap), y: y0 + CGFloat(row) * (keySize + gap), width: keySize, height: keySize)
    // 影
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: NSColor.black.withAlphaComponent(0.45).cgColor)
    colors[i].setFill()
    NSBezierPath(roundedRect: r, xRadius: 46, yRadius: 46).fill()
    ctx.restoreGState()
    // 上側を明るく
    NSGradient(colors: [NSColor.white.withAlphaComponent(0.28), NSColor.white.withAlphaComponent(0)])!
        .draw(in: NSBezierPath(roundedRect: r, xRadius: 46, yRadius: 46), angle: -90)
    glyph(i, in: r)
}
image.unlockFocus()

let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
