// 工具声明：客户流失预警清单（自定义界面；请求只发往企业微信官方接口 qyapi.weixin.qq.com）。
import { BellRing } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'w09',
  name: '客户流失预警清单',
  tagline: '按最后互动时间生成跟进清单',
  icon: BellRing,
  category: '微信私域',
  type: 'data',
  mode: 'custom',
  mainLabel: '预警清单',
  needsLLM: false,
  params: [],
  Main: ({ ctx }) => createElement(Main, { ctx }),
};

export default tool;
