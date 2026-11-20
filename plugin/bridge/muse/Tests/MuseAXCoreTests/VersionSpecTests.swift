import Testing
@testable import MuseAXCore

@Suite struct VersionSpecTests {
    @Test func parsesAndCompares() {
        #expect(Version("13.1")! == Version("13.1.0")!)
        #expect(Version("13.1")! < Version("13.10")!)
        #expect(Version("12.9")! < Version("13.0")!)
        #expect(Version("x") == nil && Version("") == nil && Version("1..2") == nil)
    }
    @Test func exactSpec() {
        #expect(VersionSpec.matches("12.1", version: "12.1"))
        #expect(VersionSpec.matches("12.1", version: "12.1.0"))
        #expect(!VersionSpec.matches("12.1", version: "12.2"))
        #expect(VersionSpec.matches("=12.1", version: "12.1"))
    }
    @Test func rangeSpec() {
        let s = ">=13.1 <14"
        #expect(VersionSpec.matches(s, version: "13.1"))
        #expect(VersionSpec.matches(s, version: "13.9.2"))
        #expect(!VersionSpec.matches(s, version: "13.0"))
        #expect(!VersionSpec.matches(s, version: "14"))
        #expect(!VersionSpec.matches(s, version: "14.0.1"))
    }
    @Test func operators() {
        #expect(VersionSpec.matches(">13.1", version: "13.1.1") && !VersionSpec.matches(">13.1", version: "13.1"))
        #expect(VersionSpec.matches("<=13.1", version: "13.1") && !VersionSpec.matches("<=13.1", version: "13.2"))
    }
    @Test func invalidSpecsNeverMatch() {
        for bad in ["", ">=", ">=x", "13.x", "~13", ">=13.1 <"] {
            #expect(!VersionSpec.isValid(bad), "\(bad)")
            #expect(!VersionSpec.matches(bad, version: "13.1"), "\(bad)")
        }
        #expect(!VersionSpec.matches("13.1", version: "garbage"))
    }
    @Test func lowerBoundOrdersProfiles() {
        #expect(VersionSpec.lowerBound(">=13.1 <14") == Version("13.1"))
        #expect(VersionSpec.lowerBound("12.1") == Version("12.1"))
        #expect(VersionSpec.lowerBound("<14") == Version("0"))
    }
}
