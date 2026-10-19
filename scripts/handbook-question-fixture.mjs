// Isolated member-to-member examples rendered by the actual question UI.
export function questionFixture(data) {
  if (data.id !== 'case-member-questions') return data;
  const { snapshot, session, username, stage, at, project } = data;
  const later = '2026-10-16T02:10:00.000Z';
  const answer = { id: 'reply-carol', body: '需要增加大输入样本。沿用本轮设备与代码版本，分别记录普通输入和大输入的耗时，并标明未验证项。', createdAt: later };
  const received = stage === 'received' || stage === 'reply';
  const automatic = stage === 'receiver-auto' || stage === 'author-auto';
  const question = {
    id: 'handbook-question', projectId: project.id, sessionId: username === 'bob' ? session.id : '',
    author: 'bob', authorName: 'Bob', title: '确认本轮验证范围',
    body: '本轮是否需要增加大输入样本？请确认补测范围和比较时要保持一致的条件。',
    context: '本轮已完成普通输入验证；样本清单见附件。',
    files: [{ name: '样本清单.csv', sha256: 'e'.repeat(64), size: 2300, owner: 'bob' }],
    recipients: [{ username: 'carol', name: 'Carol', state: received ? 'pending' : 'replied',
      activityRevision: 2, answers: received ? [] : [answer],
      ...(automatic && username === 'carol' ? { sessionId: session.id } : {}) }],
    recipientCount: 1, revision: 2, activityRevision: 2, createdAt: at, updatedAt: later,
    ...(stage === 'closed' ? { closedAt: later } : {})
  };
  session.title = username === 'bob' ? '补充验证方案' : '复核验证范围';
  snapshot.drafts = [];
  snapshot.questions = { items: stage === 'compose' ? [] : [question], jobs: [], read: {}, replyModes: {} };
  if (stage === 'receiver-auto') snapshot.questions.replyModes[question.id] = 'auto';
  if (stage === 'author-auto') snapshot.questions.dialogues = [{ questionId: question.id, projectId: project.id, peer: 'carol', sessionId: session.id, mode: 'auto' }];
  if (stage === 'imported') {
    snapshot.questions.jobs = [{ questionId: question.id, projectId: project.id, sessionId: session.id, runId: 'import-carol', mode: 'import', phase: 'tracked', sourceId: answer.id }];
    session.messages.push({ id: 'imported-reply', role: 'user', text: '问题：确认本轮验证范围\n回复人：Carol\n' + answer.body, createdAt: later });
  }
  data.question = question;
  return data;
}
