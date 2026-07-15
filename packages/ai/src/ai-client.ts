export interface AIClient {
  summarizeSchema(schema: string): Promise<string>;
  generateSql(question: string, schema: string): Promise<string>;
  answerFollowup(query: string, results: string): Promise<string>;
}

export class NotImplementedAIClient implements AIClient {
  async summarizeSchema(): Promise<string> {
    throw new Error('AI features not yet implemented');
  }

  async generateSql(): Promise<string> {
    throw new Error('AI features not yet implemented');
  }

  async answerFollowup(): Promise<string> {
    throw new Error('AI features not yet implemented');
  }
}
