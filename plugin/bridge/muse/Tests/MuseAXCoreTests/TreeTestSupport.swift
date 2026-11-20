import Foundation
@testable import MuseAXCore

/// Small builders for accessibility trees in tests.
enum T {
    static func n(_ role: String, _ title: String? = nil, value: String? = nil, desc: String? = nil, id: String? = nil, sub: String? = nil,
                  frame: (Int, Int, Int, Int) = (0, 0, 0, 0), _ kids: [TreeNode] = []) -> TreeNode {
        TreeNode(role: role, subrole: sub, identifier: id, title: title, value: value, description: desc,
                 frame: TreeFrame(x: frame.0, y: frame.1, w: frame.2, h: frame.3), children: kids)
    }

    /// A 12.1-style window with private content in it: chat names, a composer naming the open chat, and message text.
    static func sidebarTree(open: String = "Project Phoenix", other: String = "Tax return 2026", message: String = "my secret plan: buy the tickets") -> TreeNode {
        n("AXApplication", "Muse", [
            n("AXWindow", open, frame: (100, 40, 1000, 700), [
                n("AXWebArea", "", id: "root-web", frame: (100, 70, 1000, 670), [
                    n("AXGroup", "Side chats", frame: (100, 70, 220, 600), [
                        n("AXTextField", "", value: "search text typed by the user"),
                        n("AXButton", "Main chat"),
                        n("AXButton", open),
                        n("AXButton", other),
                        n("AXButton", "Channels"),
                        n("AXButton", "Search"),
                        n("AXButton", "New side chat"),
                    ]),
                    n("AXGroup", "Chat messages", frame: (330, 70, 760, 480), [
                        n("AXGroup", nil, [n("AXStaticText", "9:41")]),
                        n("AXGroup", nil, [n("AXStaticText", "You:"), n("AXStaticText", message)]),
                        n("AXGroup", nil, [n("AXStaticText", "Send"), n("AXStaticText", "an assistant answer that quotes \(other)")]),
                    ]),
                    n("AXButton", "Message in \(open) Attach files Send", frame: (340, 600, 740, 58)),
                ]),
            ]),
            n("AXMenuBar", nil, [n("AXMenuBarItem", "File")]),
        ])
    }

    /// A 13.1-style window (no sidebar; the chat list sits behind the "Chats" button).
    static func switcherTree(open: String? = "Project Phoenix", message: String = "private question about my salary") -> TreeNode {
        let composer = open.map { "Message in \($0) Attach file Dictate a message Send" } ?? "Message Attach file Dictate a message Send"
        return n("AXApplication", "Muse", [
            n("AXWindow", open ?? "Muse", frame: (533, 26, 614, 658), [
                n("AXWebArea", "", frame: (533, 56, 614, 628), [
                    n("AXButton", "Chats Unread chats Open chat and side chats", frame: (545, 70, 200, 30)),
                    n("AXGroup", "Chat messages", frame: (545, 110, 590, 440), [
                        n("AXGroup", nil, [n("AXStaticText", "User message: \(message)")]),
                        n("AXGroup", nil, [n("AXStaticText", "Assistant message: a reply")]),
                    ]),
                    n("AXButton", composer, frame: (545, 560, 590, 58)),
                ]),
            ]),
        ])
    }

    static func json(_ t: TreeNode) -> String {
        let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]
        return String(decoding: try! e.encode(t), as: UTF8.self)
    }
}
