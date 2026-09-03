# 瑙掕壊鎵紨鎻掍欢瀹夎璇存槑

閫傜敤浜?DSH锛圖eepSeek Harness锛塛eb 鐗堛€傛湰鎻掍欢浠?*瑙掕壊鎵紨涓轰富浣?*锛屾闈㈡偓娴疇鐗╀负鍙€夐檮鍔犮€傚畨瑁呭墠璇峰厛闃呰 `README.md` 浜嗚В鍔熻兘銆?
---

## 鐩綍缁撴瀯

```
dsh-roleplay-plugin/
鈹溾攢鈹€ README.md                 # 鎻掍欢鍔熻兘浠嬬粛
鈹溾攢鈹€ INSTALL.md                # 鏈畨瑁呰鏄?鈹溾攢鈹€ pet/                      # 妗屽疇绐楀彛璧勬簮锛堢珛缁樸€佺獥鍙ｈ剼鏈€佹埅鍥捐剼鏈級
鈹溾攢鈹€ agent-presets/
鈹?  鈹斺攢鈹€ roleplay/             # 瑙掕壊鎵紨棰勮锛堝惈瑙掕壊鎵紨 + 妗屽疇闄勫姞鍔熻兘锛?鈹溾攢鈹€ lib(包内 roleplay 桥接)/          # 娴忚鍣ㄤ晶杈规爮妗ユ帴锛堜晶鏍?UI锛?鈹斺攢鈹€ dependencies/
    鈹斺攢鈹€ node_modules/         # 绂荤嚎渚濊禆锛堝惈 sharp 骞冲彴浜岃繘鍒讹級
```

## 渚濊禆

- 瑙掕壊鎵紨涓庡畼鏂瑰浘鐗囷紙鐪嬫闈級鑳藉姏鐢?DSH 瀹樻柟 DeepSeek 閫傞厤鍣ㄥ師鐢熸敮鎸侊紙DSH 0.1.1+锛夛紝**鏃犻渶瀹夎瑙嗚鎻掍欢**銆?- sharp 绛夌绾夸緷璧栭殢鍘嬬缉鍖呴檮甯︼紙`dependencies/node_modules`锛夛紝渚涙瀹犳埅鍥剧瓑浣跨敤銆?
## 瀹夎姝ラ

### 鈽?鎺ㄨ崘锛氫竴閿畨瑁?
瑙ｅ帇鍚庤繍琛岋紙PowerShell锛夛細

```
pwsh install.ps1            # 瀹夎锛堝彲閫?-Default 璁句负榛樿棰勮銆?Workspace <璺緞> 鎸囧畾 DSH 宸ヤ綔鍖猴級
pwsh install.ps1 -Uninstall # 涓€閿挙閿€锛坧atch 绉婚櫎/妗ユ帴鍒犻櫎锛?Presets 涓€骞跺垹棰勮锛?Pet 涓€骞跺垹妗屽疇锛?```

鑴氭湰浼氳嚜鍔細鏀剧疆涓変釜棰勮 鈫?鏀剧疆妗屽疇璧勬簮 鈫?鏀剧疆渚ф爮妗ユ帴 鈫?**瀹夊叏鍚堝苟 cordis.patch.yml**锛堝厛澶囦唤 .bak锛屽紓甯歌嚜鍔ㄥ洖婊氾級銆傛墍鏈夋敼鍔ㄥ彲涓€閿嵏杞姐€?
> 濡傛灉 DSH 鍚姩寮傚父锛歚pwsh install.ps1 -Uninstall` 鍥炴粴鍗冲彲鎭㈠銆?
<details>
<summary>鎵嬪姩瀹夎锛堝閫夛級锛?/summary>

### 1. 鏀剧疆棰勮

鎶?`agent-presets\roleplay`锛堟亱鐖卞悜锛屽惈瑙掕壊鎵紨 + 妗屽疇闄勫姞鍔熻兘锛夋暣涓枃浠跺す澶嶅埗鍒帮細

```
%USERPROFILE%\.dsh\.agent-presets\roleplay
```

闇€瑕併€屾湅鍙嬪悜 / OC 鍘熷垱鍚戙€嶆椂锛屾妸 `agent-presets\roleplay-friend`銆乣agent-presets\roleplay-oc` 涔熷鍒跺埌 `%USERPROFILE%\.dsh\.agent-presets\` 涓嬶紙涓変釜棰勮鍏辩敤鍚屼竴寮曟搸銆佹暟鎹洰褰曞悇鑷嫭绔嬶細`.roleplay` / `.roleplay-friend` / `.roleplay-oc`锛夈€?
> 鎭嬬埍鍚戜负涓讳綋锛堣鑹叉壆婕?+ 妗屽疇涓€閿惎鍔級锛涙湅鍙嬪悜涓虹函鍙嬭皧杞达紙鏃犲姪鍔?鐢峰弸鍔涳紝閲岀▼纰戞湅鍙嬪悜锛夛紱OC 鍘熷垱鍚戦粯璁ゅ叏绌虹櫧锛堜笉棰勭疆鍏崇郴/鍏绘垚瑙勫垯锛夈€?
### 2. 鏀剧疆妗屽疇璧勬簮

鎶?`pet` 鏂囦欢澶瑰鍒跺埌浣犵殑 **DSH 宸ヤ綔鍖?* 涓嬬殑 `pet` 鐩綍锛?
```
<浣犵殑 DSH 宸ヤ綔鍖?\pet
```

> 馃挕 璺緞宸插彲閰嶇疆锛堜笉鍐嶇‖缂栫爜锛夈€傞粯璁わ細鏁版嵁鏍?= DSH 宸ヤ綔鍖猴紙瑙掕壊鏁版嵁鍦ㄥ伐浣滃尯鐨?`.roleplay`锛夈€佹瀹犺祫婧?= DSH 宸ヤ綔鍖轰笅 `pet`銆?> 濡傞渶鎹㈡瀹犺祫婧愪綅缃紝璁剧疆鐜鍙橀噺 `DSH_PET_DIR`锛堝繀椤绘槸宸ヤ綔鍖哄唴锛夊嵆鍙紝**鏃犻渶鏀逛唬鐮?*銆?
### 3. 鏀剧疆渚ф爮妗ユ帴

鎶?`lib(包内 roleplay 桥接)` 鏂囦欢澶瑰鍒跺埌锛?
```
%USERPROFILE%\.dsh\profiles\web\node_modules\@dsh-user\lib(包内 roleplay 桥接)
```

锛堣鐩栧悓鍚嶇洰褰曘€傗殸锔?涓嶈鍦?profile 鐩綍杩愯 `pnpm install`锛屽畠浼氭竻鎺夋湭澹版槑鐨?node_modules 鍐呭銆傦級

鐒跺悗鍦?`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 杩藉姞锛堟病鏈夊垯鏂板缓锛夛細

```yaml
- insert:
    - id: lib(包内 roleplay 桥接)
      name: '@ajuwm/dsh-roleplay-plugin'
```

### 4. 璁句负榛樿棰勮锛堝彲閫夛級

缂栬緫 `%USERPROFILE%\.dsh\settings.yaml`锛?
```yaml
agent-presets:
  default: roleplay
```

> 涓嶈缃篃涓嶅奖鍝嶏細瑙掕壊鎵紨浠嶅彲鍦ㄩ璁惧垪琛ㄩ噷鎵嬪姩閫夋嫨銆傗殸锔?DSH 鐨勯璁惧垏鎹㈠彧瀵广€岀┖鐧斤紙杩樻病鍙戣繃绗竴鍙ヨ瘽锛変細璇濄€嶇敓鏁堬紝鎵€浠ユ墜鍔ㄥ垏鎹㈡椂璇峰厛閫夊ソ棰勮銆佺‘璁ゅ凡搴旂敤锛屽啀鍙戠涓€鏉℃秷鎭€?
### 5. 閲嶅惎 DSH

</details>
閲嶅惎鍚庡埛鏂伴〉闈€傛柊寤轰細璇濓紙榛樿瑙掕壊鎵紨棰勮锛夛紝渚ф爮鐐广€屸柖 寮€濮嬫壆婕斻€嶅嵆鍙紑濮嬨€?
## 浣跨敤

- 瑙掕壊鎵紨鍏ュ彛锛氳緭鍏ユ涓婃柟 馃幁 姘旀场鎸夐挳 鈫?鍙充晶杈规爮
- 妗屽疇锛堥檮鍔狅級锛氫晶鏍忋€屽惎鍔ㄦ瀹犮€嶆寜閽紝鎴栧弻鍑荤珛缁樺璇濄€佸崟鍑昏Е鎽搞€佹寜浣忔嫋鍔?- 璇︾粏鍔熻兘瑙?`README.md`

## 鏁版嵁涓庢枃浠?
| 鍐呭 | 浣嶇疆 |
|------|------|
| 妗屽疇璁剧疆 | `<DSH 宸ヤ綔鍖?\pet\config.json` |
| 瑙掕壊鐘舵€?璁剧疆 | `<DSH 宸ヤ綔鍖?\.roleplay\character.json` |
| 瑙掕壊鍗?| `<DSH 宸ヤ綔鍖?\.roleplay\cards.json` |
| 瑙掕壊璁板繂锛堝惈鏈鍑哄彛鐨勫康澶达級 | `<DSH 宸ヤ綔鍖?\.roleplay\mem-<瑙掕壊鍚?.json` |
| 瑙掕壊鏃ヨ | `<DSH 宸ヤ綔鍖?\.roleplay\diary-<瑙掕壊鍚?-<鏃ユ湡>.md` |
| 妗岄潰鎴浘 | `<DSH 宸ヤ綔鍖?\.roleplay\desktop-look.png` |
| 妗屽疇鍢€鍜?| `<DSH 宸ヤ綔鍖?\.roleplay\bubble.txt` |

> `DSH 宸ヤ綔鍖篳 = DSH 杩愯/閰嶇疆鐨?workspace 鐩綍锛堝嵆 `sandboxPolicy.workspaceRoot`锛夛紝涓嶆槸 `%USERPROFILE%\.dsh`锛堥偅鏄?DSH 閰嶇疆鐩綍锛夈€?> 瑙掕壊鍗″簱锛坄cards.json`锛夋槸**鍏ㄥ眬鍏变韩**鐨勶細鎭嬬埍鍚?鏈嬪弸鍚?OC 鍘熷垱鍚戠殑浠讳綍瀵硅瘽閲屼繚瀛樼殑鍗★紝鍏朵粬瀵硅瘽閮借兘鐪嬪埌骞跺垏鎹紱瑙掕壊璁板繂/鏃ヨ/浜插瘑搴?鍏绘垚鎸夎鑹查殧绂伙紝瀵硅瘽鍘嗗彶姣忎細璇濈嫭绔嬨€?
