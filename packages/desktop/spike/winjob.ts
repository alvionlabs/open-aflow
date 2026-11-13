// SPIKE ONLY. Windows Job Objects and a process snapshot through koffi (FFI, prebuilt; no build tools).
// One job per run, KILL_ON_JOB_CLOSE, no breakaway. The pty host holds the only handle, so when the host
// ends (quit, crash, app crash), Windows ends every process in the job.

// Packaged: main names koffi's folder in resources/native, outside the asar. Unpackaged: normal lookup.
const koffi = require(process.env.OPENAFLOW_KOFFI_PATH ?? 'koffi') as typeof import('koffi')

const k32 = koffi.load('kernel32.dll')
const HANDLE = koffi.pointer('HANDLE', koffi.opaque())

const BASIC = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
  PerProcessUserTimeLimit: 'int64',
  PerJobUserTimeLimit: 'int64',
  LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'size_t',
  MaximumWorkingSetSize: 'size_t',
  ActiveProcessLimit: 'uint32',
  Affinity: 'size_t',
  PriorityClass: 'uint32',
  SchedulingClass: 'uint32',
})
const IO = koffi.struct('IO_COUNTERS', {
  ReadOperationCount: 'uint64',
  WriteOperationCount: 'uint64',
  OtherOperationCount: 'uint64',
  ReadTransferCount: 'uint64',
  WriteTransferCount: 'uint64',
  OtherTransferCount: 'uint64',
})
const EXTENDED = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
  BasicLimitInformation: BASIC,
  IoInfo: IO,
  ProcessMemoryLimit: 'size_t',
  JobMemoryLimit: 'size_t',
  PeakProcessMemoryUsed: 'size_t',
  PeakJobMemoryUsed: 'size_t',
})
const ENTRY = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('char16_t', 260, 'String'),
})

const CreateJobObjectW = k32.func('HANDLE CreateJobObjectW(void *attrs, const char16_t *name)')
const SetInformationJobObject = k32.func('bool SetInformationJobObject(HANDLE job, int cls, _In_ JOBOBJECT_EXTENDED_LIMIT_INFORMATION *info, uint32 len)')
const QueryInformationJobObject = k32.func('bool QueryInformationJobObject(HANDLE job, int cls, _Out_ uint8_t *info, uint32 len, _Out_ uint32 *ret)')
const AssignProcessToJobObject = k32.func('bool AssignProcessToJobObject(HANDLE job, HANDLE proc)')
const TerminateJobObject = k32.func('bool TerminateJobObject(HANDLE job, uint32 code)')
const IsProcessInJob = k32.func('bool IsProcessInJob(HANDLE proc, HANDLE job, _Out_ bool *result)')
const OpenProcess = k32.func('HANDLE OpenProcess(uint32 access, bool inherit, uint32 pid)')
const GetCurrentProcess = k32.func('HANDLE GetCurrentProcess()')
const CloseHandle = k32.func('bool CloseHandle(HANDLE h)')
const GetLastError = k32.func('uint32 GetLastError()')
const CreateToolhelp32Snapshot = k32.func('HANDLE CreateToolhelp32Snapshot(uint32 flags, uint32 pid)')
const Process32FirstW = k32.func('bool Process32FirstW(HANDLE snap, _Inout_ PROCESSENTRY32W *e)')
const Process32NextW = k32.func('bool Process32NextW(HANDLE snap, _Inout_ PROCESSENTRY32W *e)')

const JobObjectBasicProcessIdList = 3
const JobObjectExtendedLimitInformation = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TH32CS_SNAPPROCESS = 0x2
const INVALID = -1n

export type Job = { handle: unknown; closed: boolean }

export function createJob(): Job {
  const handle = CreateJobObjectW(null, null)
  if (!handle) throw new Error(`CreateJobObjectW failed: ${GetLastError()}`)
  const info = {
    BasicLimitInformation: { PerProcessUserTimeLimit: 0, PerJobUserTimeLimit: 0, LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, MinimumWorkingSetSize: 0, MaximumWorkingSetSize: 0, ActiveProcessLimit: 0, Affinity: 0, PriorityClass: 0, SchedulingClass: 0 },
    IoInfo: { ReadOperationCount: 0, WriteOperationCount: 0, OtherOperationCount: 0, ReadTransferCount: 0, WriteTransferCount: 0, OtherTransferCount: 0 },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  }
  if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, info, koffi.sizeof(EXTENDED))) {
    const err = GetLastError()
    CloseHandle(handle)
    throw new Error(`SetInformationJobObject failed: ${err}`)
  }
  return { handle, closed: false }
}

/** Puts a running process in the job. Its later children join the job too. */
export function assign(job: Job, pid: number): { ok: boolean; error?: number; inJob?: boolean } {
  const proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!proc) return { ok: false, error: GetLastError() }
  try {
    if (!AssignProcessToJobObject(job.handle, proc)) return { ok: false, error: GetLastError() }
    const r = [false]
    IsProcessInJob(proc, job.handle, r)
    return { ok: true, inJob: r[0] }
  } finally {
    CloseHandle(proc)
  }
}

/** Process IDs in the job now. */
export function jobPids(job: Job): number[] {
  if (job.closed) return []
  const buf = Buffer.alloc(8 + 8 * 1024)
  const ret = [0]
  if (!QueryInformationJobObject(job.handle, JobObjectBasicProcessIdList, buf, buf.length, ret)) return []
  const n = buf.readUInt32LE(4)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(Number(buf.readBigUInt64LE(8 + 8 * i)))
  return out
}

export function terminateJob(job: Job, code = 1): boolean {
  return job.closed ? false : TerminateJobObject(job.handle, code)
}

export function closeJob(job: Job) {
  if (job.closed) return
  job.closed = true
  CloseHandle(job.handle)
}

/** Is this process (the host) already in some job (Electron's, or a parent's)? */
export function selfInJob(): boolean {
  const r = [false]
  IsProcessInJob(GetCurrentProcess(), null, r)
  return r[0]
}

/** Every process's parent and image name, from a Toolhelp snapshot. Parent IDs can be stale after a parent exits. */
export function snapshot(): Map<number, { ppid: number; exe: string }> {
  const out = new Map<number, { ppid: number; exe: string }>()
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (!snap || koffi.address(snap) === BigInt.asUintN(64, INVALID)) return out
  try {
    const e: any = { dwSize: koffi.sizeof(ENTRY), szExeFile: '' }
    let ok = Process32FirstW(snap, e)
    while (ok) {
      out.set(e.th32ProcessID, { ppid: e.th32ParentProcessID, exe: e.szExeFile })
      e.dwSize = koffi.sizeof(ENTRY)
      ok = Process32NextW(snap, e)
    }
  } finally {
    CloseHandle(snap)
  }
  return out
}
