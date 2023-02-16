import { Config } from "./config.js";
import { Message } from "wechaty";
import { ContactInterface, RoomInterface } from "wechaty/impls";
import { Configuration, OpenAIApi } from "openai";
import mysql from 'mysql';
import axios from "axios";

//创建连接conn
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '123456',
  database: 'gitHub'
});

connection.connect();

// ChatGPT error response configuration
const chatgptErrorMessage = "🤖️：AI机器人摆烂了，请稍后再试～";

// ChatGPT model configuration
// please refer to the OpenAI API doc: https://beta.openai.com/docs/api-reference/introduction
const ChatGPTModelConfig = {
  // this model field is required
  model: "text-davinci-003",
  // add your ChatGPT model parameters below
  temperature: 0, // 数值越低得到的回答越理性，取值范围[0, 1]
  max_tokens: 1000,
  top_p: 1,  // 生成的文本的文本与要求的符合度, 取值范围[0, 1]
  // frequency_penalty: 0.2, // 用于平衡生成的文本的频率和多样性。该参数的值越大，生成的文本就越不常见，也越不符合常识。相反，该参数的值越小，生成的文本就越常见，也越符合常识。
  // presence_penalty: 0.5, // 用于平衡生成的文本的内容丰富程度和符合提示的程度。该参数的值越大，生成的文本就越符合提示，内容丰富程度越低。相反，该参数的值越小，生成的文本就越不符合提示，内容丰富程度越高。
};

// message size for a single reply by the bot
const SINGLE_MESSAGE_MAX_SIZE = 500;
const SUFFIX_STRING = "\n----------\n我是Chopin, 提问请看群公告.";
enum MessageType {
  Unknown = 0,
  Attachment = 1, // Attach(6),
  Audio = 2, // Audio(1), Voice(34)
  Contact = 3, // ShareCard(42)
  ChatHistory = 4, // ChatHistory(19)
  Emoticon = 5, // Sticker: Emoticon(15), Emoticon(47)
  Image = 6, // Img(2), Image(3)
  Text = 7, // Text(1)
  Location = 8, // Location(48)
  MiniProgram = 9, // MiniProgram(33)
  GroupNote = 10, // GroupNote(53)
  Transfer = 11, // Transfers(2000)
  RedEnvelope = 12, // RedEnvelopes(2001)
  Recalled = 13, // Recalled(10002)
  Url = 14, // Url(5)
  Video = 15, // Video(4), Video(43)
  Post = 16, // Moment, Channel, Tweet, etc
}

export class ChatGPTBot {
  botName: string = "";
  chatgptTriggerKeyword = Config.chatgptTriggerKeyword;
  OpenAIConfig: any; // OpenAI API key
  OpenAI: any; // OpenAI API instance

  // Chatgpt fine-tune for being a chatbot (guided by OpenAI official document)
  applyContext(text: string): string {
    return `You are an artificial intelligence bot from a company called "OpenAI". Your primary tasks are chatting with users and answering their questions.\nIf the user says: ${text}.\nYou will say: `;
  }

  setBotName(botName: string) {
    this.botName = botName;
  }

  // get trigger keyword in group chat: (@Name <keyword>)
  // in group chat, replace the special character after "@username" to space
  // to prevent cross-platfrom mention issue
  get chatGroupTriggerKeyword(): string {
    return `@${this.botName} ${this.chatgptTriggerKeyword || ""}`;
  }

  // configure API with model API keys and run an initial test
  async startGPTBot() {
    try {
      // OpenAI Account configuration
      this.OpenAIConfig = new Configuration({
        organization: Config.openaiOrganizationID,
        apiKey: Config.openaiApiKey,
      });
      // OpenAI API instance
      this.OpenAI = new OpenAIApi(this.OpenAIConfig);
      // Hint user the trigger keyword in private chat and group chat
      console.log(`🤖️ Chatbot name is: ${this.botName}`);
      console.log(`🎯 Trigger keyword in private chat is: ${this.chatgptTriggerKeyword}`);
      console.log(`🎯 Trigger keyword in group chat is: ${this.chatGroupTriggerKeyword}`);
      // Run an initial test to confirm API works fine
      await this.onChatGPT("Say Hello World");
      console.log(`✅ Chatbot starts success, ready to handle message!`);
    } catch (e) {
      console.error(`❌ ${e}`);
    }
  }

  // get clean message by removing reply separater and group mention characters
  cleanMessage(rawText: string, isPrivateChat: boolean = false): string {
    let text = rawText;
    const item = rawText.split("- - - - - - - - - - - - - - -");
    if (item.length > 1) {
      text = item[item.length - 1];
    }
    return text.slice(
      isPrivateChat
        ? this.chatgptTriggerKeyword.length
        : this.chatGroupTriggerKeyword.length
    );
  }

  // check whether ChatGPT bot can be triggered
  triggerGPTMessage(text: string, isPrivateChat: boolean = false): boolean {
    const chatgptTriggerKeyword = this.chatgptTriggerKeyword;
    let triggered = false;
    if (isPrivateChat) {
      triggered = chatgptTriggerKeyword
        ? text.startsWith(chatgptTriggerKeyword)
        : true;
    } else {
      // due to un-unified @ lagging character, ignore it and just match:
      //    1. the "@username" (mention)
      //    2. trigger keyword
      // start with @username
      const textMention = `@${this.botName}`;
      const startsWithMention = text.startsWith(textMention);
      const textWithoutMention = text.slice(textMention.length + 1);
      const followByTriggerKeyword = textWithoutMention.startsWith(
        this.chatgptTriggerKeyword
      );
      triggered = startsWithMention && followByTriggerKeyword;
    }
    if (triggered) {
      console.log(`🎯 Chatbot triggered: ${text}`);
    }
    return triggered;
  }

  // filter out the message that does not need to be processed
  isNonsense(
    talker: ContactInterface,
    messageType: MessageType,
    text: string
  ): boolean {
    return (
      // self-chatting can be used for testing
      talker.self() ||
      messageType != MessageType.Text ||
      talker.name() == "微信团队" ||
      talker.name().indexOf("微信") >= 0 ||
      talker.name().indexOf("腾讯") >= 0 ||
      // video or voice reminder
      text.includes("收到一条视频/语音聊天消息，请在手机上查看") ||
      // red pocket reminder
      text.includes("收到红包，请在手机上查看") ||
      // location information
      text.includes("/cgi-bin/mmwebwx-bin/webwxgetpubliclinkimg")
    );
  }

  // send question to ChatGPT with OpenAI API and get answer
  async onChatGPT(text: string): Promise<string> {
    const inputMessage = this.applyContext(text);
    try {
      const data = {prompt:text,
        conversation_id: "06f4614e-5bb7-4ba6-968a-cbd0a44cafbb",
      };
      const config = {
        headers: {
          'Content-Type': 'application/json'
        }
      };
      const response = await axios.post('http://127.0.0.1:8080/api', data,config);

      const chatgptReplyMessage = response?.data?.message?.trim();
      // // config OpenAI API request body
      // const response = await this.OpenAI.createCompletion({
      //   ...ChatGPTModelConfig,
      //   prompt: inputMessage,
      // });
      // // // use OpenAI API to get ChatGPT reply message
      // const chatgptReplyMessage = response?.data?.choices[0]?.text?.trim();
      console.log("🤖️ Chatbot says: ", chatgptReplyMessage);
      return chatgptReplyMessage;
    } catch (e: any) {
      console.error(`❌ ${e}`);
      const errorResponse = e?.response;
      const errorCode = errorResponse?.status;
      const errorStatus = errorResponse?.statusText;
      const errorMessage = errorResponse?.data?.error?.message;
      console.error(`❌ Code ${errorCode}: ${errorStatus}`);
      console.error(`❌ ${errorMessage}`);
      return chatgptErrorMessage + "code: " + errorCode;
    }
  }

  // reply with the segmented messages from a single-long message
  async reply(
    talker: RoomInterface | ContactInterface,
    mesasge: string
  ): Promise<void> {
    const messages: Array<string> = [];
    let message = mesasge;
    while (message.length > SINGLE_MESSAGE_MAX_SIZE) {
      messages.push(message.slice(0, SINGLE_MESSAGE_MAX_SIZE));
      message = message.slice(SINGLE_MESSAGE_MAX_SIZE);
    }
    messages.push(message);
    for (const msg of messages) {
      await talker.say(msg);
    }
  }

  // reply to private message
  async onPrivateMessage(talker: ContactInterface, text: string): Promise<boolean> {
    // get reply from ChatGPT
    const chatgptReplyMessage = await this.onChatGPT(text);

    // send the ChatGPT reply to chat
    await this.reply(talker, chatgptReplyMessage + SUFFIX_STRING);
    if (chatgptReplyMessage.indexOf(chatgptErrorMessage) >= 0) {
      return false
    }
    return true
  }

  // reply to group message
  async onGroupMessage(room: RoomInterface, text: string): Promise<boolean> {
    // get reply from ChatGPT
    const chatgptReplyMessage = await this.onChatGPT(text);
    // the whole reply consist of: original text and bot reply
    const wholeReplyMessage = `${text}\n----------\n${chatgptReplyMessage}`;
    await this.reply(room, wholeReplyMessage + SUFFIX_STRING);
    if (chatgptReplyMessage.indexOf(chatgptErrorMessage) >= 0) {
      return false
    }
    return true
  }

  // receive a message (main entry)
  async onMessage(message: Message) {
    const talker = message.talker();
    const name = message.talker().name();
    const rawText = message.text();
    const room = message.room();
    const messageType = message.type();
    const isPrivateChat = !room;
    // do nothing if the message:
    //    1. is irrelevant (e.g. voice, video, location...), or
    //    2. doesn't trigger bot (e.g. wrong trigger-word)

    const date = new Date().toISOString().slice(0, 10);
    const text = this.cleanMessage(rawText, isPrivateChat);

    if (
      this.isNonsense(talker, messageType, rawText) ||
      !this.triggerGPTMessage(rawText, isPrivateChat)
    ) {
      return;
    }

    if (text.indexOf("兑换码") == 0) { // 兑换兑换码
      const key = text.slice(3,text.length);
      try {
        const response = await axios.postForm('https://www.shaobingriyu.com/api/user/openai/ticket/consume', {userId:key});
        console.log(response.data);
        if (response.data.code == 0) { // 兑换成功
          connection.query(
            `UPDATE request_limit SET request_count = request_count + 3 WHERE user_id = "${name}" AND date = "${date}"`,
            (error, rows, fields) => {
              if (error) throw error;
              message.say(`${text}\n----------\n` + "兑换成功,本日提问次数+3." + SUFFIX_STRING);
            }
          )
          return;
        }else{
          message.say(`${text}\n----------\n` +  "兑换失败:今日未激活该验证码或者已兑换." + SUFFIX_STRING);
          return;
        }
      } catch (error) {
        console.error(error);
      }
      return;
    }

    connection.query(
      `SELECT * FROM request_limit WHERE user_id = "${name}" AND date = "${date}"`,
     async (error, rows, fields) =>  {
        if (error) throw error;
      var requestCount = 0;
      if (rows.length > 0) { // 有数据
      const res = rows[0];
      if (res.request_count == 0) {
        message.say(`${text}\n----------\n` + "每人每天免费问一个问题, 兑换码兑换后可以增加3次 ,想问更多可以私聊'我是DJ'询问." + SUFFIX_STRING);
        return;
      }
      requestCount = res.request_count;
    }

    // clean the message for ChatGPT input
    // reply to private or group chat 
    var success = false
    if (isPrivateChat) {
      success =  await this.onPrivateMessage(talker, text);
    } else {
      success =  await this.onGroupMessage(room, text);
    }
    if (success) {
      if (rows.length > 0) {
        // Update existing data
        requestCount = requestCount - 1;
  
        connection.query(
          `UPDATE request_limit SET request_count = ${requestCount} WHERE user_id = "${name}" AND date = "${date}"`,
          (error, rows, fields) => {
            if (error) throw error;
          }
        )
      } else {
        // delete history
        connection.query(
          `DELETE FROM request_limit WHERE user_id = "${name}"`,
          (error, rows, fields) => {
            if (error) throw error;
          // Insert new data
          connection.query(
            `INSERT INTO request_limit (user_id, date, request_count) VALUES ("${name}", "${date}", 0)`,
            (error, rows, fields) => {
              if (error) throw error;
    
            }
          )
          }
        )
      }
    }

      }
    );
    return;
  }
}
