import { z } from 'zod';

// Accounts are also personal folder names on both Windows and Linux.
export const accountNameSchema = z.string().trim().min(1, '请输入登录账号').max(64, '登录账号最多 64 个字符')
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}_·-]*$/u, '账号支持中文姓名、数字工号、大小写字母、下划线、短横线和间隔号，请勿包含空格或路径符号')
  .refine(value => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value), '此账号是系统保留名称，请换一个姓名或工号');
export const accountPasswordSchema = z.string().min(1, '密码不能为空').max(4096, '密码过长')
  .regex(/^[^\r\n\x00:]+$/, '密码不能包含冒号、换行或空字符');

export const newAccountPasswordSchema = accountPasswordSchema;
