// 一次性: 冲突菜单项去除坏字符 "??" 并与暂停开关文案区分;同步开关 i18n 值与代码对齐
const fs = require("fs");
const updates = {
  "i18n/zh_CN.json": {
    sygspMenuResolveConflict: "处理冲突(自动同步已暂停)",
    sygspMenuPauseAutoSync: "暂停同步",
    sygspMenuResumeAutoSync: "恢复同步(当前已暂停)",
  },
  "i18n/en_US.json": {
    sygspMenuResolveConflict: "Resolve conflicts (auto sync paused)",
    sygspMenuPauseAutoSync: "Pause sync",
    sygspMenuResumeAutoSync: "Resume sync (currently paused)",
  },
};
for (const [f, patch] of Object.entries(updates)) {
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  Object.assign(data, patch);
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + "\n");
  console.log(f + " updated");
}
