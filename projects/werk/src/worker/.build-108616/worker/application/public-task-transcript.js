                                                            

/** Match retained generated context exactly so transcript trimming cannot rewrite a genuine follow-up. */
export function publicTaskConversation(snapshot                                            , task                                                    )                                             {
  if (!task) return snapshot;
  const context = (task.instruction + '\nApproved paths: ' + task.paths.join(', ')).slice(0, 8000);
  return { ...snapshot, messages: snapshot.messages.map(message => message.role === 'user' && message.text === context ? { ...message, text: task.instruction } : message) };
}
