begin;

-- Upgrade saved copies of the semantic-keyword prompt without replacing unrelated
-- administrator customizations. Runtime validation remains authoritative: each
-- constraint is activated only when its value exists in the primary keyword.
update public.app_settings
set
  value = jsonb_set(
    case
      when jsonb_typeof(value #> '{templates,semanticKeywords.generation}') = 'string' then
        jsonb_set(
          value,
          '{templates,semanticKeywords.generation}',
          to_jsonb(
            replace(
              replace(
                replace(
                  replace(
                    value #>> '{templates,semanticKeywords.generation}',
                    '- يجب أن تحتوي كل صيغة بديلة على جميع الأرقام الموجودة في الكلمة الأساسية بالقيم نفسها؛ لا تحذف رقمًا ولا تبدله ولا تضف رقمًا جديدًا.',
                    '- إذا احتوت الكلمة الأساسية رقمًا، حافظ عليه في كل صيغة بديلة بالقيمة نفسها. إذا لم تحتوِ رقمًا فلا تضف رقمًا ولا تعتبره قيدًا.'
                  ),
                  '- استخرج أي دولة أو مدينة أو محافظة أو مقاطعة أو ولاية أو إقليم أو منطقة مذكورة في الكلمة الأساسية، وضعها في protectedQualifiers، ثم أبقها في كل صيغة بديلة. لا تستبدل الموقع بموقع أوسع أو أضيق أو مختلف.',
                  '- إذا احتوت الكلمة الأساسية دولة أو مدينة أو محافظة أو مقاطعة أو ولاية أو إقليمًا أو منطقة، ضع الموجود فقط في protectedQualifiers وحافظ عليه في كل صيغة بديلة. إذا لم يوجد موقع فلا تضف موقعًا ولا تعتبره قيدًا.'
                ),
                '- استخرج أي قومية أو نسبة جغرافية أو عرقية مذكورة في الكلمة الأساسية، وضعها في protectedQualifiers، ثم أبقها في كل صيغة بديلة من دون تحويلها إلى قومية أخرى.',
                '- إذا احتوت الكلمة الأساسية قومية أو نسبة جغرافية أو عرقية، ضع الموجود فقط في protectedQualifiers وحافظ عليه في كل صيغة بديلة دون تحويله إلى قومية أخرى. إذا لم توجد قومية فلا تضفها ولا تعتبرها قيدًا.' || E'\n' ||
                '- القيود الثلاثة مستقلة: قد يكون المطلوب رقمًا فقط، أو موقعًا فقط، أو قومية فقط، أو أي جمع بينها بحسب الكلمة الأساسية نفسها.'
              ),
              '- أنشئ من 10 إلى 16 كيانًا أو مفهومًا أو مصطلحًا سياقيًا يساعد على تغطية الموضوع، وليس إعادة صياغة للكلمة الأساسية.',
              '- أنشئ من 10 إلى 16 كيانًا أو مفهومًا أو مصطلحًا سياقيًا يساعد على تغطية الموضوع، وليس إعادة صياغة للكلمة الأساسية.' || E'\n' ||
              '- لا يُشترط أن تتضمن كلمات LSI الرقم أو الموقع أو القومية المحمية؛ يكفي ارتباطها الدلالي الصحيح بالموضوع.'
            )
          ),
          true
        )
      else value
    end,
    '{registryVersion}',
    '10'::jsonb,
    true
  ),
  updated_at = now()
where key = 'prompts'
  and jsonb_typeof(value) = 'object';

commit;
