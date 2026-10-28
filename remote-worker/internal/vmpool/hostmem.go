package vmpool

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// memAvailable is the seam over readHostMemAvailable: a package-level var so a
// test can pin the host's answer (there is no /proc/meminfo on darwin, and even on
// linux a test cannot arrange a specific MemAvailable). Same indirection pattern
// as chvChown/chvChmod in launcher_chv.go.
var memAvailable = readHostMemAvailable

// readHostMemAvailable reads MemAvailable out of /proc/meminfo, in bytes.
//
// MemAvailable rather than MemFree is the whole choice: MemFree excludes page
// cache the kernel would reclaim under pressure, so a floor on MemFree fires long
// before the host is actually short — back-pressure from a number the kernel
// itself does not consider a shortage (#644).
//
// /proc/meminfo reports kB columns (kernel KBYTES, i.e. 1024-byte units) with no
// suffix on the value itself, e.g. "MemAvailable:  1503232 kB".
func readHostMemAvailable() (int64, error) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, fmt.Errorf("vmpool: reading /proc/meminfo: %w", err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		rest, ok := strings.CutPrefix(line, "MemAvailable:")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 2 || fields[1] != "kB" {
			return 0, fmt.Errorf("vmpool: parsing MemAvailable from %q: want \"<n> kB\"", strings.TrimSpace(rest))
		}
		kb, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("vmpool: parsing MemAvailable %q: %w", fields[0], err)
		}
		return kb * 1024, nil
	}
	return 0, fmt.Errorf("vmpool: no MemAvailable line in /proc/meminfo")
}
