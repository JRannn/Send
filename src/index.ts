type TargetType = 'group' | 'private';

interface ScheduledMessage {
  id: string;
  targetType: TargetType;
  targetId: string;
  content: string;
  runAt: number;
  createdAt: number;
  creatorId: string;
}

const EXT_NAME = 'scheduled-send';
const STORAGE_KEY = 'tasks';

function main() {
  let ext = seal.ext.find(EXT_NAME);
  if (!ext) {
    ext = seal.ext.new(EXT_NAME, 'Codex', '1.0.0');
    seal.ext.register(ext);
  }
  let timer: number | null = null;

  const loadTasks = (): ScheduledMessage[] => {
    const raw = ext.storageGet(STORAGE_KEY);
    if (!raw) return [];

    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];

      return data.filter(isScheduledMessage);
    } catch (_) {
      return [];
    }
  };

  const saveTasks = (tasks: ScheduledMessage[]) => {
    ext.storageSet(STORAGE_KEY, JSON.stringify(tasks));
  };

  const scheduleNextCheck = () => {
    if (timer !== null) clearTimeout(timer);

    const tasks = loadTasks();
    if (tasks.length === 0) {
      timer = null;
      return;
    }

    const nextRunAt = Math.min(...tasks.map((task) => task.runAt));
    const delay = Math.max(0, nextRunAt - Date.now());
    timer = setTimeout(runDueTasks, delay);
  };

  const sendScheduledMessage = (task: ScheduledMessage): boolean => {
    const ep = seal.getEndPoints().find((item) => item.enable) ?? seal.getEndPoints()[0];
    if (!ep) return false;

    const targetId = normalizeTargetId(task.targetType, task.targetId, ep.platform);
    const tempMsg = seal.newMessage();
    tempMsg.platform = ep.platform || 'QQ';
    tempMsg.message = task.content;
    tempMsg.time = Math.floor(Date.now() / 1000);
    tempMsg.messageType = task.targetType;
    tempMsg.rawId = targetId;
    tempMsg.sender = {
      nickname: '',
      userId: targetId,
    };

    if (task.targetType === 'group') {
      tempMsg.groupId = targetId;
    }

    const tempCtx = seal.createTempCtx(ep, tempMsg);
    if (task.targetType === 'group') {
      seal.replyGroup(tempCtx, tempMsg, task.content);
    } else {
      seal.replyPerson(tempCtx, tempMsg, task.content);
    }

    return true;
  };

  const runDueTasks = () => {
    const now = Date.now();
    const tasks = loadTasks();
    const remaining: ScheduledMessage[] = [];
    let changed = false;

    for (const task of tasks) {
      if (task.runAt > now) {
        remaining.push(task);
        continue;
      }

      changed = true;
      const sent = sendScheduledMessage(task);
      if (!sent) {
        remaining.push(task);
      }
    }

    if (changed) saveTasks(remaining);
    scheduleNextCheck();
  };

  scheduleNextCheck();

  const cmd = seal.ext.newCmdItemInfo();
  cmd.name = '定时发送';
  cmd.help = [
    '定时发送：指定日期时间向 QQ 群或私聊发送内容，默认只发送一次。',
    '新增：.定时发送 add 2026-05-21 09:30:15 群 123456 内容',
    '新增：.定时发送 add 2026-05-21 09:30:15 私 123456 内容',
    '时间也可以只写到分钟，如 09:30，此时秒数按 00 处理。',
    '列表：.定时发送 list',
    '删除：.定时发送 del 任务ID',
  ].join('\n');

  cmd.solve = (ctx, msg, cmdArgs) => {
    const sub = cmdArgs.getArgN(1);

    if (!sub || sub === 'help' || sub === '帮助') {
      const ret = seal.ext.newCmdExecuteResult(true);
      ret.showHelp = true;
      return ret;
    }

    if (sub === 'list' || sub === '列表') {
      const tasks = loadTasks().sort((a, b) => a.runAt - b.runAt);
      if (tasks.length === 0) {
        seal.replyToSender(ctx, msg, '当前没有待发送的定时消息。');
        return seal.ext.newCmdExecuteResult(true);
      }

      const lines = tasks.map((task) => {
        const typeText = task.targetType === 'group' ? '群' : '私';
        return `${task.id} | ${formatDateTime(task.runAt)} | ${typeText} ${task.targetId} | ${task.content}`;
      });
      seal.replyToSender(ctx, msg, `待发送定时消息：\n${lines.join('\n')}`);
      return seal.ext.newCmdExecuteResult(true);
    }

    if (sub === 'del' || sub === 'delete' || sub === '删除') {
      const id = cmdArgs.getArgN(2);
      if (!id) {
        seal.replyToSender(ctx, msg, '请提供要删除的任务ID。用法：.定时发送 del 任务ID');
        return seal.ext.newCmdExecuteResult(true);
      }

      const tasks = loadTasks();
      const nextTasks = tasks.filter((task) => task.id !== id);
      if (nextTasks.length === tasks.length) {
        seal.replyToSender(ctx, msg, `没有找到任务：${id}`);
        return seal.ext.newCmdExecuteResult(true);
      }

      saveTasks(nextTasks);
      scheduleNextCheck();
      seal.replyToSender(ctx, msg, `已删除定时消息：${id}`);
      return seal.ext.newCmdExecuteResult(true);
    }

    if (sub !== 'add' && sub !== '新增') {
      seal.replyToSender(ctx, msg, '未知操作。发送 .定时发送 help 查看用法。');
      return seal.ext.newCmdExecuteResult(true);
    }

    const dateText = cmdArgs.getArgN(2);
    const timeText = cmdArgs.getArgN(3);
    const targetTypeText = cmdArgs.getArgN(4);
    const targetId = cmdArgs.getArgN(5);
    const content = cmdArgs.getRestArgsFrom(6).trim();

    const targetType = parseTargetType(targetTypeText);
    const runAt = parseDateTime(dateText, timeText);

    if (!runAt || !targetType || !targetId || !content) {
      seal.replyToSender(ctx, msg, [
        '参数不完整或格式不正确。',
        '用法：.定时发送 add 2026-05-21 09:30:15 群 123456 内容',
        '类型可用：群、群聊、group、私、私聊、private',
      ].join('\n'));
      return seal.ext.newCmdExecuteResult(true);
    }

    if (runAt <= Date.now()) {
      seal.replyToSender(ctx, msg, '发送时间必须晚于当前时间。');
      return seal.ext.newCmdExecuteResult(true);
    }

    const task: ScheduledMessage = {
      id: createTaskId(),
      targetType,
      targetId,
      content,
      runAt,
      createdAt: Date.now(),
      creatorId: msg.sender?.userId || '',
    };

    const tasks = loadTasks();
    tasks.push(task);
    saveTasks(tasks);
    scheduleNextCheck();

    const typeText = task.targetType === 'group' ? '群' : '私聊';
    seal.replyToSender(ctx, msg, `已添加定时消息 ${task.id}：将在 ${formatDateTime(task.runAt)} 发送到${typeText} ${task.targetId}。`);
    return seal.ext.newCmdExecuteResult(true);
  };

  ext.cmdMap['定时发送'] = cmd;
  ext.cmdMap['timedsend'] = cmd;
}

function isScheduledMessage(value: unknown): value is ScheduledMessage {
  if (!value || typeof value !== 'object') return false;

  const task = value as ScheduledMessage;
  return (
    typeof task.id === 'string' &&
    (task.targetType === 'group' || task.targetType === 'private') &&
    typeof task.targetId === 'string' &&
    typeof task.content === 'string' &&
    typeof task.runAt === 'number' &&
    typeof task.createdAt === 'number'
  );
}

function parseTargetType(value: string): TargetType | null {
  const text = (value || '').toLowerCase();
  if (text === '群' || text === '群聊' || text === 'group' || text === 'g') return 'group';
  if (text === '私' || text === '私聊' || text === 'private' || text === 'p' || text === 'qq') return 'private';
  return null;
}

function normalizeTargetId(targetType: TargetType, targetId: string, platform: string): string {
  if (targetId.includes(':')) return targetId;

  const platformName = platform || 'QQ';
  if (targetType === 'group') return `${platformName}-Group:${targetId}`;

  return `${platformName}:${targetId}`;
}

function parseDateTime(dateText: string, timeText: string): number | null {
  const dateMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(dateText || '');
  const timeMatch = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(timeText || '');
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] || '0');

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }

  return date.getTime();
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function createTaskId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 10000).toString(36)}`;
}

main();
