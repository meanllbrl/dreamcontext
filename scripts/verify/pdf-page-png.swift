// Usage: swift pdf-page-png.swift <in.pdf> <out-prefix>  → <out-prefix>-<n>.png per page, 2x.
import Quartz
let a = CommandLine.arguments
let d = PDFDocument(url: URL(fileURLWithPath: a[1]))!
print("pages", d.pageCount)
for i in 0..<d.pageCount {
  let p = d.page(at: i)!; let r = p.bounds(for: .mediaBox); let s: CGFloat = 2
  let img = NSImage(size: NSSize(width: r.width * s, height: r.height * s))
  img.lockFocus(); NSColor.white.set(); NSRect(x: 0, y: 0, width: r.width * s, height: r.height * s).fill()
  let c = NSGraphicsContext.current!.cgContext; c.scaleBy(x: s, y: s); p.draw(with: .mediaBox, to: c); img.unlockFocus()
  let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(a[2])-\(i + 1).png"))
}
