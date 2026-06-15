import { readdir, mkdir, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const testsDir = __dirname;

const TEST_FILE_PATTERN = /-test\.js$/;

async function findTestFiles() {
  const files = await readdir(testsDir);
  return files
    .filter((f) => TEST_FILE_PATTERN.test(f) && f !== "run-all.js")
    .sort()
    .map((f) => join(testsDir, f));
}

async function createTempDataDir() {
  const tmpBase = join(projectRoot, "tmp", "test-data");
  await mkdir(tmpBase, { recursive: true });
  const dir = join(tmpBase, `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function cleanupTempDir(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    // 忽略清理错误
  }
}

function runTestFile(testFile, dataDir) {
  return new Promise((resolve) => {
    const testName = basename(testFile);
    const env = {
      ...process.env,
      ZFL_DATA_DIR: dataDir,
      NODE_ENV: "test"
    };

    const child = spawn(process.execPath, [testFile], {
      env,
      cwd: projectRoot,
      stdio: ["inherit", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    child.on("close", (code) => {
      resolve({
        testFile,
        testName,
        exitCode: code,
        passed: code === 0,
        stdout,
        stderr
      });
    });

    child.on("error", (err) => {
      resolve({
        testFile,
        testName,
        exitCode: -1,
        passed: false,
        stdout,
        stderr: stderr + "\n" + err.message,
        error: err
      });
    });
  });
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ZFL-9 测试套件");
  console.log("=".repeat(60));

  const testFiles = await findTestFiles();
  console.log(`\n发现 ${testFiles.length} 个测试文件\n`);

  const results = [];
  let tempDirs = [];

  for (const testFile of testFiles) {
    const testName = basename(testFile);
    const dataDir = await createTempDataDir();
    tempDirs.push(dataDir);

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`运行: ${testName}`);
    console.log(`数据目录: ${dataDir}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const result = await runTestFile(testFile, dataDir);
    results.push(result);

    const status = result.passed ? "通过" : "失败";
    console.log(`\n结果: ${status} (退出码: ${result.exitCode})`);
  }

  // 清理临时目录
  for (const dir of tempDirs) {
    await cleanupTempDir(dir);
  }

  // 汇总
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log("\n");
  console.log("=".repeat(60));
  console.log("  测试汇总");
  console.log("=".repeat(60));
  console.log(`  总计: ${total} 个测试文件`);
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  console.log("=".repeat(60));

  if (failed > 0) {
    console.log("\n失败的测试:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ ${r.testName}`);
    }
    console.log("");
    process.exit(1);
  } else {
    console.log("\n  全部通过 ✓\n");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("测试运行器出错:", err);
  process.exit(1);
});
