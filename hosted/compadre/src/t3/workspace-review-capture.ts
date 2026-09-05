import { randomUUID } from "node:crypto";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import {
  workspaceReviewSchema,
  type WorkspaceReview,
} from "./workspace-review.js";

// The controller executes this on the already-running worker. All comparisons
// resolve immutable Git objects, including T3's uncommitted-file checkpoints.
export const WORKSPACE_REVIEW_CAPTURE_SCRIPT = String.raw`
import sys,json,subprocess,hashlib,datetime,signal
signal.alarm(110)
q=json.loads(sys.argv[1]); cwd=q['cwd']; blobs={}; total=0
MAX_FILE=1024*1024; MAX_TOTAL=20*1024*1024; MAX_PATCH=2*1024*1024; MAX_FILES=1000
def git(*args):
 return subprocess.check_output(['git',*args],cwd=cwd,stderr=subprocess.DEVNULL,timeout=30)
def ref(r): return git('rev-parse','--verify',r+'^{commit}').decode().strip()
head=ref('HEAD'); start=ref(q['fromRef']); end=ref(q['toRef']); initial=ref(q['initialRef'])
branch=git('branch','--show-current').decode().strip() or head[:12]
baseLabel='Thread start'; base=initial
for candidate in ['refs/remotes/origin/main','refs/remotes/origin/master','refs/heads/main','refs/heads/master']:
 try:
  base=git('merge-base',candidate,head).decode().strip();baseLabel=candidate;break
 except subprocess.CalledProcessError: pass
def blob(revision,path):
 global total
 if git('cat-file','-t',revision+':'+path).strip()!=b'blob': return None,'Submodule; text context is unavailable'
 size=int(git('cat-file','-s',revision+':'+path))
 if size>MAX_FILE: return None,'File exceeds the 1 MiB saved-context limit'
 data=git('cat-file','blob',revision+':'+path)
 if b'\x00' in data: return None,'Binary file; text context is unavailable'
 try: text=data.decode('utf8')
 except UnicodeDecodeError: return None,'File is not UTF-8 text'
 digest=hashlib.sha256(data).hexdigest()
 if digest not in blobs:
  if total+len(data)>MAX_TOTAL: return None,'Snapshot exceeds the saved-context budget'
  blobs[digest]=text;total+=len(data)
 return digest,None
def comparison(kind,before,after,beforeLabel,afterLabel):
 entries=git('diff','--name-status','-z','--find-renames',before,after,'--').decode().split('\0');files=[];patches=[];ignored=[];patchBytes=0;truncated=False
 while entries and entries[0]:
  status=entries.pop(0);old=entries.pop(0);new=entries.pop(0) if status.startswith('R') else old
  if len(files)>=MAX_FILES: truncated=True;break
  oldBlob,oldError=(None,None) if status=='A' else blob(before,old)
  newBlob,newError=(None,None) if status=='D' else blob(after,new)
  # Passing both paths preserves rename detection; argument-array execution
  # and the pathspec boundary keep filenames out of shell syntax.
  args=['diff','--no-color','--no-ext-diff','--no-textconv','--find-renames',before,after,'--',old]
  if new!=old: args.append(new)
  oversized=any(error and ('limit' in error or 'budget' in error) for error in [oldError,newError])
  patch='' if oversized else git(*args).decode('utf8',errors='replace')
  if oversized: truncated=True
  white='' if oversized else git(*args[:1],'--ignore-all-space',*args[1:]).decode('utf8',errors='replace')
  additions=sum(line.startswith('+') and not line.startswith('+++') for line in patch.splitlines())
  deletions=sum(line.startswith('-') and not line.startswith('---') for line in patch.splitlines())
  item=dict(oldPath=old,newPath=new,kind={'A':'added','D':'deleted'}.get(status,'renamed' if status.startswith('R') else 'modified'),additions=additions,deletions=deletions,oldBlob=oldBlob,newBlob=newBlob)
  if oldError or newError: item['unavailableReason']=oldError or newError
  files.append(item)
  size=len(patch.encode())+len(white.encode())
  if patchBytes+size>MAX_PATCH: truncated=True;continue
  patches.append(patch);ignored.append(white);patchBytes+=size
 return dict(kind=kind,baseRef=before,headRef=after,baseLabel=beforeLabel,headLabel=afterLabel,diff=''.join(patches),ignoreWhitespaceDiff=''.join(ignored),files=files,truncated=truncated)
comparisons=[comparison('turn',start,end,'Previous turn','Completed turn'),comparison('thread',initial,end,'Thread start','Completed turn'),comparison('branch-range',base,end,baseLabel,branch),comparison('working-tree',head,end,branch,'Captured working tree')]
output=json.dumps(dict(version=1,capturedAt=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),workerTurnId=q['turnId'],checkpointTurnCount=q['turnCount'],comparisons=comparisons,blobs=blobs),ensure_ascii=False)
if 'outputPath' in q:
 with open(q['outputPath'],'w',encoding='utf8') as f: f.write(output)
else: print(output)
`;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export async function captureWorkspaceReview(
  sandbox: SandboxHandle,
  input: {
    cwd: string;
    fromRef: string;
    toRef: string;
    initialRef: string;
    turnId: string;
    turnCount: number;
  },
): Promise<WorkspaceReview> {
  const outputPath = `/tmp/compadre-review-${randomUUID()}.json`;
  const command = `python3 -c ${quote(WORKSPACE_REVIEW_CAPTURE_SCRIPT)} ${quote(JSON.stringify({ ...input, outputPath }))}`;
  try {
    const result = await sandbox.process.exec(command, {
      signal: AbortSignal.timeout(120_000),
    });
    if (result.exitCode !== 0)
      throw new Error("Worker could not capture the completed Git checkpoint");
    return workspaceReviewSchema.parse(
      JSON.parse(
        Buffer.from(await sandbox.fs.readBytes(outputPath)).toString("utf8"),
      ),
    );
  } finally {
    await sandbox.fs.remove(outputPath).catch(() => {});
  }
}
